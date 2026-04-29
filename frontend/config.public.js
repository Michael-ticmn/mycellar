// Public Supabase config — committed to the repo. Loaded before
// config.local.js (which is gitignored and may override for local dev).
//
// The anon key is designed to be public; security relies on RLS policies
// in the Supabase project. The URL is also public. NEVER put the
// service_role key here — that one bypasses RLS and belongs only in
// watcher/.env.
window.CELLAR_CONFIG = {
  SUPABASE_URL: 'https://fksvvymeqvohyaestupo.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZrc3Z2eW1lcXZvaHlhZXN0dXBvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0MDcwMjgsImV4cCI6MjA5Mjk4MzAyOH0.PLngWivZr-qPerqtZUwHpRarx9ipzANV_GJgyz7YwGM',
};
