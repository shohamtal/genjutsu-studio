# Genjutsu Studio

Pay-as-you-go web front for Higgsfield's **Genjutsu** video model (motion transfer + object swap).
Visitors sign in with email, buy credits via PayPal, and generate videos. No subscription.

- **Frontend**: static site in `docs/` → GitHub Pages. Runs in *demo mode* until `docs/config.js` is filled.
- **Backend**: Supabase (Auth + Postgres + Storage + 4 Edge Functions). Needed because the Higgsfield
  and PayPal secrets must never reach the browser.

## How it works
1. User uploads video + photo(s) → Supabase Storage bucket `inputs/<user_id>/…` (public URLs).
2. `generate` asks Higgsfield's `/estimate` for the real USD cost, converts to credits
   (`1 credit = $0.01 retail`, `retail = cost × MARKUP`), atomically deducts, submits with
   `Idempotency-Key = job id` and a webhook.
3. The job row lives in Postgres, so refreshing/closing the page never loses it. The page polls `jobs`;
   Higgsfield also calls `hf-webhook`. Both re-read the authoritative status from Higgsfield.
4. `failed` / `nsfw` / `canceled` → credits refunded exactly once (`refund_job`).
5. `paypal` creates the order server-side at a fixed pack price and credits the account only after a
   verified capture (idempotent `complete_payment`). Money lands in your PayPal account.

## Setup (~15 min)
1. **Supabase**: create a project. SQL editor → run `supabase/migrations/001_init.sql`.
   Auth → URL configuration → add your Pages URL to *Site URL* / *Redirect URLs*.
   (Optional) Auth → Email templates → Magic link: add `{{ .Token }}` so users also get a 6-digit code.
2. **Higgsfield**: https://open.higgsfield.ai → top up balance → create API key (id + secret).
3. **PayPal**: https://developer.paypal.com → Apps & Credentials → create app (Sandbox first, then Live).
4. **Deploy functions** (`brew install supabase/tap/supabase`):
   ```bash
   supabase login && supabase link --project-ref <ref>
   supabase secrets set HF_API_KEY_ID=… HF_API_KEY_SECRET=… \
     PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… PAYPAL_ENV=sandbox \
     WEBHOOK_SECRET=$(openssl rand -hex 24) MARKUP=1.5 \
     ALLOWED_ORIGIN=https://<you>.github.io
   supabase functions deploy paypal generate jobs hf-webhook
   ```
5. Fill `docs/config.js` with the Supabase URL, anon key and PayPal **client id** (public values), push.
   Keep `PACKS` in sync with `supabase/functions/paypal/index.ts`, and `CREDITS_PER_SEC` ≈ rate × MARKUP × 100.
6. Test with PayPal sandbox buyer account → switch `PAYPAL_ENV=live` + live client id/secret.

## Pricing reference (Higgsfield, Sept 2026)
480p $0.159/s · 720p $0.681/s · 1080p $1.632/s. Source video 4–30 s, 1–8 reference images.
