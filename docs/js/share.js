// Owner-side share-link helpers. The token lives in the share_links
// table; creation goes through cellar27_share_create() (SECURITY DEFINER)
// which atomically revokes any prior active link. Revoke is a plain RLS
// UPDATE.

import { sb } from './supabase-client.js';

export async function getActiveShareLink() {
  const { data, error } = await sb
    .from('share_links')
    .select('id, token, expires_at, ai_quota, ai_used, revoked_at')
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function createShareLink({ ttlHours, aiQuota }) {
  const { data, error } = await sb.rpc('cellar27_share_create', {
    p_ttl_hours: ttlHours,
    p_ai_quota:  aiQuota,
  });
  if (error) throw error;
  return Array.isArray(data) && data.length ? data[0] : null;
}

export async function revokeShareLink(id) {
  const { error } = await sb
    .from('share_links')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export function shareUrlFor(token) {
  // Use the current site origin + path; the guest route is hash-based.
  const base = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`;
  return `${base}#/guest/${token}`;
}
