// guest-label — mint a short-lived signed URL for a bottle's label photo,
// for anonymous share-link guests.
//
// Why this exists: `bottle-labels` is a private bucket whose Storage policies
// are all `to authenticated` and scoped to the owner's own folder, so an anon
// guest can neither read an object nor create a signed URL for one. The two
// share RPCs also deliberately withhold label paths (see the header comment in
// 0013_guest_plan_view.sql). Rather than relax either of those, this function
// does the lookup server-side with the service key and hands back only a URL.
//
// The URL expires in 10 minutes and access is bound to an active share link —
// revoke or expire the link and photos stop resolving immediately, with no
// lingering public URL.
//
// Note what this does NOT hide: a Supabase signed URL embeds the object path
// (.../object/sign/bottle-labels/<owner-uuid>/scan-<uuid>-front.jpg), so the
// guest does see the bucket, the owner's user_id, and the filename. That was
// verified to be inert — the bucket is private, so the bare path 400s without a
// signature, the public-object route 400s, an anon-key read is refused by
// Storage RLS, and a signature can't be replayed against a different object.
// Signing requires the service key, which only this function holds. What the
// share RPCs still withhold is the path as reusable *data* alongside the other
// owner-private fields.
//
// Deploy:  supabase functions deploy guest-label
// Verify:  curl "$SUPABASE_URL/functions/v1/guest-label?token=<t>&bottle_id=<id>" \
//            -H "Authorization: Bearer $SUPABASE_ANON_KEY"

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SIGNED_URL_TTL_SECONDS = 600;
const BUCKET = 'bottle-labels';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Per-token throttle. A guest opening bottle detail modals fires one request
// per open, so a real visit is a handful per minute; 60 leaves enormous room
// while still stopping a leaked token from being used to pull the whole cellar's
// photos in a loop.
//
// This is isolate-local, which makes it a speed bump rather than a guarantee:
// Supabase may run several isolates, and they don't share state. That's the
// honest scope. A hard limit would need a counter in Postgres, which isn't
// worth a round-trip per request for label photos of your own wine — but revisit
// if this endpoint ever returns something that matters more. The real
// containment remains the share link: revoke it and this stops serving.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
const hits = new Map<string, number[]>();

function rateLimited(token: string): boolean {
  const now = Date.now();
  const recent = (hits.get(token) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    hits.set(token, recent);
    return true;
  }
  recent.push(now);
  hits.set(token, recent);
  // Bound memory in a long-lived isolate: drop tokens whose window has fully
  // aged out. Cheap because it only runs once the map is already large.
  if (hits.size > 1000) {
    for (const [k, v] of hits) {
      if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
    }
  }
  return false;
}

// The guest app is served from GitHub Pages, so this is a cross-origin call.
// `*` is acceptable here because knowledge of the share token is what actually
// gates the response — the origin isn't the secret.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);

  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const bottleId = url.searchParams.get('bottle_id');
  if (!token || !bottleId) return json({ error: 'missing_params' }, 400);

  // Reject a malformed id here rather than letting Postgres raise on the uuid
  // cast — that path returned a 500 for what is plainly a bad request.
  if (!UUID_RE.test(bottleId)) return json({ error: 'invalid_bottle_id' }, 400);

  if (rateLimited(token)) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: { ...CORS, 'Content-Type': 'application/json', 'Retry-After': '60' },
    });
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // 1. Resolve the share link. Same predicate the share RPCs use, so a revoked
  //    or expired link stops serving photos at exactly the same moment it stops
  //    serving everything else.
  const { data: link, error: linkErr } = await sb
    .from('share_links')
    .select('owner_user_id')
    .eq('token', token)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (linkErr) return json({ error: 'lookup_failed' }, 500);
  if (!link) return json({ error: 'link_invalid' }, 403);

  // 2. Confirm the bottle belongs to that link's owner. Without this check a
  //    valid token could be used to read any bottle photo in the database.
  const { data: bottle, error: bottleErr } = await sb
    .from('bottles')
    .select('id, label_image_path')
    .eq('id', bottleId)
    .eq('user_id', link.owner_user_id)
    .maybeSingle();
  if (bottleErr) return json({ error: 'lookup_failed' }, 500);
  if (!bottle) return json({ error: 'not_found' }, 404);
  if (!bottle.label_image_path) return json({ error: 'no_photo' }, 404);

  // 3. Sign it. Short TTL — the guest page fetches on demand when the modal
  //    opens, so there's no reason for the URL to outlive the visit.
  const { data: signed, error: signErr } = await sb.storage
    .from(BUCKET)
    .createSignedUrl(bottle.label_image_path, SIGNED_URL_TTL_SECONDS);
  if (signErr || !signed?.signedUrl) return json({ error: 'sign_failed' }, 500);

  return json({ url: signed.signedUrl, expires_in: SIGNED_URL_TTL_SECONDS });
});
