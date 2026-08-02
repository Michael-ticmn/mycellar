import { sb } from './supabase-client.js';

export async function getSession() {
  const { data } = await sb.auth.getSession();
  return data.session;
}

export async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

// No signUp() here on purpose: sign-ups are disabled in the Supabase project
// (see ARCHITECTURE.md, "Security shape"). Accounts are created from the
// dashboard and added to cellar27_allowed_users, so a client-side sign-up path
// could only ever surface an error.

export async function signOut() {
  const { error } = await sb.auth.signOut();
  if (error) throw error;
}

export function onAuthChange(cb) {
  return sb.auth.onAuthStateChange((_event, session) => cb(session));
}
