import { sb } from './supabase-client.js';
import { suggestDrinkWindow } from './varietal-windows.js';

// All queries rely on RLS to scope by user_id; we still set user_id on insert.

// Everything except `details`, which is the AI enrichment blob — capped at 8 KB
// a row and never read by any list view. Pulling it for the whole cellar on
// every grid paint was most of the payload for none of the value; the detail
// page uses getBottle(), which still selects everything.
const LIST_COLUMNS = [
  'id', 'producer', 'wine_name', 'varietal', 'blend_components', 'vintage',
  'region', 'country', 'style', 'sweetness', 'body', 'quantity',
  'storage_location', 'acquired_date', 'acquired_price',
  'drink_window_start', 'drink_window_end', 'drink_window_overridden',
  'notes', 'label_image_path', 'back_image_path', 'created_at', 'updated_at',
].join(', ');

export async function listBottles({ orderBy = 'created_at', ascending = false } = {}) {
  const { data, error } = await sb
    .from('bottles')
    .select(LIST_COLUMNS)
    .order(orderBy, { ascending });
  if (error) throw error;
  return data;
}

export async function getBottle(id) {
  const { data, error } = await sb.from('bottles').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

// Fetch several bottles in one round-trip and return them as a Map keyed by id.
// The render paths that show AI picks used to await getBottle() per
// recommendation — one request each, serially in the flight/plan case. Missing
// ids simply don't appear in the map, which is what callers already handle
// (a pick can reference a bottle that's since been deleted).
export async function getBottlesByIds(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await sb.from('bottles').select('*').in('id', unique);
  if (error) throw error;
  return new Map((data || []).map((b) => [b.id, b]));
}

// Auto-fills drink_window_start/end from varietal+vintage if user didn't set them.
// Sets drink_window_overridden=false in the auto case, true if user provided either.
export async function createBottle(input) {
  const { data: userData } = await sb.auth.getUser();
  if (!userData?.user) throw new Error('Not signed in');

  const userOverrode = input.drink_window_start != null || input.drink_window_end != null;
  let { drink_window_start, drink_window_end } = input;

  if (!userOverrode && input.vintage) {
    // Prefer the sommelier's structured window (from enrichment) when present —
    // it's wine-specific and keeps the columns consistent with the rationale.
    // Fall back to the generic varietal/style lookup otherwise.
    const aiStart = Number.isInteger(input.details?.drink_window_start) ? input.details.drink_window_start : null;
    const aiEnd   = Number.isInteger(input.details?.drink_window_end)   ? input.details.drink_window_end   : null;
    if (aiStart && aiEnd && aiEnd >= aiStart) {
      drink_window_start = aiStart;
      drink_window_end = aiEnd;
    } else {
      const { start, end } = suggestDrinkWindow({
        varietal: input.varietal,
        style: input.style,
        vintage: input.vintage,
      });
      drink_window_start = start;
      drink_window_end = end;
    }
  }

  const row = {
    ...input,
    user_id: userData.user.id,
    drink_window_start,
    drink_window_end,
    drink_window_overridden: userOverrode,
  };

  const { data, error } = await sb.from('bottles').insert(row).select().single();
  if (error) throw error;
  return data;
}

export async function updateBottle(id, patch) {
  // If user touches drink window fields, flip the override flag.
  const touchesWindow = 'drink_window_start' in patch || 'drink_window_end' in patch;
  const finalPatch = touchesWindow ? { ...patch, drink_window_overridden: true } : patch;
  const { data, error } = await sb.from('bottles').update(finalPatch).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

// Store sommelier enrichment. The enrichment carries a structured drink window
// (details.drink_window_start/end); promote it into the canonical columns so the
// numeric window the app sorts/badges on matches the prose rationale. Never
// clobber a window the user set by hand (drink_window_overridden), and never flip
// the override flag — this is an auto value, not a manual one.
export async function saveEnrichment(id, details) {
  const patch = { details };
  const s = Number.isInteger(details?.drink_window_start) ? details.drink_window_start : null;
  const e = Number.isInteger(details?.drink_window_end)   ? details.drink_window_end   : null;
  if (s && e && e >= s) {
    const current = await getBottle(id);
    if (!current.drink_window_overridden) {
      patch.drink_window_start = s;
      patch.drink_window_end = e;
    }
  }
  const { data, error } = await sb.from('bottles').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteBottle(id) {
  const { error } = await sb.from('bottles').delete().eq('id', id);
  if (error) throw error;
}

// Find an existing bottle that's the SAME wine (so a scan-add can offer
// "increment quantity" instead of creating a duplicate row). Different
// vintage is treated as a different bottle. Falls back to varietal-match
// when wine_name is missing on either side.
export async function findDuplicate({ producer, wine_name, vintage, varietal }) {
  if (!producer || vintage == null) return null;
  const norm = (s) => (s || '').trim().toLowerCase();
  const np = norm(producer);
  const nw = norm(wine_name);
  const nv = norm(varietal);

  // Let Postgres narrow it instead of pulling the whole cellar down on every
  // scan save. `ilike` is case-insensitive, matching how norm() compares.
  //
  // The pattern has to be escaped. `%` and `_` are LIKE wildcards, so an
  // unescaped producer of "50% Blend" — or worse, a bare "%" out of a bad label
  // read — matches far more rows than intended, and this query selects `*`.
  // That is exactly the whole-cellar pull this was rewritten to avoid, so the
  // widening isn't cosmetic even though the exact norm() comparison below still
  // decides correctness. Backslash is Postgres's default LIKE escape character.
  //
  // Known gap: PostgREST also treats `*` as an alias for `%` in like/ilike
  // patterns and offers no escape for it, so a producer containing a literal
  // asterisk still widens. No wine has one; noted so it isn't mistaken for
  // thoroughness.
  //
  // Selects `*` deliberately: the caller merges label paths and details off the
  // match, so this is the one list-ish read that does need the full row.
  const likePattern = producer.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data, error } = await sb.from('bottles')
    .select('*')
    .ilike('producer', likePattern)
    .eq('vintage', vintage);   // different year = different bottle
  if (error) throw error;

  return (data || []).find((b) => {
    if (norm(b.producer) !== np) return false;
    const bw = norm(b.wine_name);
    if (nw && bw) return nw === bw;
    if (!nw && !bw) return norm(b.varietal) === nv;
    return false; // one has wine_name, other doesn't — treat as different
  }) || null;
}

// Tap-to-pour: -1 with a floor of 0.
//
// Goes through an RPC rather than read-then-write. The old version fetched the
// row, subtracted one, and wrote it back — two pours in flight together both
// read N and both wrote N-1, losing one. The RPC is a single UPDATE with
// `quantity > 0` in the WHERE clause, so the decrement and the floor check
// can't be split. It runs SECURITY INVOKER, so RLS still scopes it to the
// caller's own bottles.
//
// No rows back means the guard rejected it: either the bottle is at zero or it
// isn't visible to this user. Both read the same way to the person tapping.
// Migrations are applied by hand, so the frontend can go live before 0018 does.
// PostgREST answers a call to a function that doesn't exist with PGRST202; when
// we see that, fall back to the old read-then-write. It carries the lost-update
// race this change exists to fix, but a race beats a Pour button that just
// errors. Delete this fallback once 0018 is applied everywhere.
function isMissingFunction(error) {
  return error?.code === 'PGRST202'
    || /Could not find the function|does not exist/i.test(error?.message || '');
}

export async function pourBottle(id) {
  const { data, error } = await sb.rpc('cellar27_pour_bottle', { p_bottle_id: id });
  if (error) {
    if (!isMissingFunction(error)) throw error;
    const b = await getBottle(id);
    if (b.quantity <= 0) throw new Error('No bottles left to pour');
    return updateBottle(id, { quantity: b.quantity - 1 });
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('No bottles left to pour');
  return row;
}

export async function undoPour(id) {
  const { data, error } = await sb.rpc('cellar27_unpour_bottle', { p_bottle_id: id });
  if (error) {
    if (!isMissingFunction(error)) throw error;
    const b = await getBottle(id);
    return updateBottle(id, { quantity: b.quantity + 1 });
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("Couldn't undo — bottle not found.");
  return row;
}
