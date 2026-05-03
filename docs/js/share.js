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

// Owner-side: list messages guests have sent on this share link, newest
// first. Direct query — RLS gates by share_links.owner_user_id, so we
// don't need a SECURITY DEFINER RPC.
export async function listGuestMessages(shareLinkId) {
  const { data, error } = await sb
    .from('guest_messages')
    .select('id, created_at, guest_name, kind, payload')
    .eq('share_link_id', shareLinkId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// Owner-side helper used by the nav badge: how many messages have
// landed on this owner's currently-active share link since `since`
// (an ISO timestamp from localStorage). Tolerant of no-active-link
// (returns 0 silently).
export async function countGuestMessagesSince(shareLinkId, sinceIso) {
  if (!shareLinkId) return 0;
  const { count, error } = await sb
    .from('guest_messages')
    .select('id', { count: 'exact', head: true })
    .eq('share_link_id', shareLinkId)
    .gt('created_at', sinceIso || '1970-01-01T00:00:00Z');
  if (error) return 0;
  return count || 0;
}
