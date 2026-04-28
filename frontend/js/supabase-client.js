// Supabase client singleton.
//
// Reads config from window.CELLAR_CONFIG, which is populated by
// `config.local.js` (git-ignored). See frontend/README.md for setup.
//
// The Supabase JS v2 UMD bundle is loaded from CDN in index.html and
// exposes a global `supabase` namespace with createClient.

const cfg = window.CELLAR_CONFIG;
if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
  throw new Error(
    'Missing window.CELLAR_CONFIG. Copy frontend/config.local.example.js → frontend/config.local.js and fill in your Supabase URL + anon key.'
  );
}

export const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});
