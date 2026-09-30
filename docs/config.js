// Public config only — no secrets here. Leave SUPABASE_URL empty to run in demo mode.
window.GENJUTSU_CONFIG = {
  SUPABASE_URL: "https://tbljgxkbocunzoqvkoeu.supabase.co",          // e.g. https://abcd1234.supabase.co
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRibGpneGtib2N1bnpvcXZrb2V1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3OTIyNzQsImV4cCI6MjEwNjM2ODI3NH0.I9aNlsdJrrsrPCtfMlS6BQKhsnu7DmcCP7CoXiUXPvA",     // public anon key
  PAYPAL_CLIENT_ID: "BAASP_Y0Zn4e93GHi1cuO-ryNVrwXG4GO8mIkFRnVqrXfXJCZkrBYSA7r8aKgrzUnQ1_xaSt5gha3fTadg",      // PayPal REST app client id (sandbox or live)

  // Display only. The server (supabase/functions/paypal) is authoritative.
  PACKS: [
    { id: "starter", usd: 5, credits: 500, label: "Starter" },
    { id: "creator", usd: 15, credits: 1600, label: "Creator", tag: "Popular" },
    { id: "studio", usd: 40, credits: 4500, label: "Studio", tag: "Best value" },
  ],
  // Trend preset loaded on the home page. Users only add the two photos.
  PRESET: {
    title: "White Chicks — car scene",
    video_url: "https://tbljgxkbocunzoqvkoeu.supabase.co/storage/v1/object/public/inputs/presets/white-chicks-car.mp4",
    poster: "https://tbljgxkbocunzoqvkoeu.supabase.co/storage/v1/object/public/inputs/presets/white-chicks-car.jpg",
    mode: "motion-transfer",
    resolution: "720p",
    prompt: "Replace both characters with the uploaded pictures",
    slots: ["Person on the left", "Person on the right"],
  },

  // Display-only cost preview: credits per second of output (server uses Higgsfield's estimate).
  CREDITS_PER_SEC: { "480p": 24, "720p": 103, "1080p": 245 },
};
