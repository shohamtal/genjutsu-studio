// Public config only — no secrets here. Leave SUPABASE_URL empty to run in demo mode.
window.GENJUTSU_CONFIG = {
  SUPABASE_URL: "",          // e.g. https://abcd1234.supabase.co
  SUPABASE_ANON_KEY: "",     // public anon key
  PAYPAL_CLIENT_ID: "",      // PayPal REST app client id (sandbox or live)

  // Display only. The server (supabase/functions/paypal) is authoritative.
  PACKS: [
    { id: "starter", usd: 5, credits: 500, label: "Starter" },
    { id: "creator", usd: 15, credits: 1600, label: "Creator", tag: "Popular" },
    { id: "studio", usd: 40, credits: 4500, label: "Studio", tag: "Best value" },
  ],
  // Display-only cost preview: credits per second of output (server uses Higgsfield's estimate).
  CREDITS_PER_SEC: { "480p": 24, "720p": 103, "1080p": 245 },
};
