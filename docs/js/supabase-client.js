// Supabase client singleton.
//
// Reads config from window.CELLAR_CONFIG, populated by config.public.js
// (committed) and optionally overridden by config.local.js (gitignored).
// See docs/README.md for setup.
//
// The Supabase JS v2 UMD bundle is loaded from CDN in index.html and
// exposes a global `supabase` namespace with createClient.

const cfg = window.CELLAR_CONFIG;
if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
  throw new Error(
    'Missing window.CELLAR_CONFIG. Check docs/config.public.js or copy docs/config.local.example.js → docs/config.local.js.'
  );
}

export const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});
