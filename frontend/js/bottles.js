import { sb } from './supabase-client.js';
import { suggestDrinkWindow } from './varietal-windows.js';

// All queries rely on RLS to scope by user_id; we still set user_id on insert.

export async function listBottles({ orderBy = 'created_at', ascending = false } = {}) {
  const { data, error } = await sb
    .from('bottles')
    .select('*')
    .order(orderBy, { ascending });
  if (error) throw error;
  return data;
}

export async function getBottle(id) {
  const { data, error } = await sb.from('bottles').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

// Auto-fills drink_window_start/end from varietal+vintage if user didn't set them.
// Sets drink_window_overridden=false in the auto case, true if user provided either.
export async function createBottle(input) {
  const { data: userData } = await sb.auth.getUser();
  if (!userData?.user) throw new Error('Not signed in');

  const userOverrode = input.drink_window_start != null || input.drink_window_end != null;
  let { drink_window_start, drink_window_end } = input;

  if (!userOverrode && input.vintage) {
    const { start, end } = suggestDrinkWindow({
      varietal: input.varietal,
      style: input.style,
      vintage: input.vintage,
    });
    drink_window_start = start;
    drink_window_end = end;
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

export async function deleteBottle(id) {
  const { error } = await sb.from('bottles').delete().eq('id', id);
  if (error) throw error;
}

// Tap-to-pour: -1 with quantity floor of 0.
export async function pourBottle(id) {
  const b = await getBottle(id);
  if (b.quantity <= 0) throw new Error('No bottles left to pour');
  return updateBottle(id, { quantity: b.quantity - 1 });
}

export async function undoPour(id) {
  const b = await getBottle(id);
  return updateBottle(id, { quantity: b.quantity + 1 });
}
