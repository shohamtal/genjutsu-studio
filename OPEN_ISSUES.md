# Open issues

Known gaps we've decided to leave for now.

- **Generated videos live on Higgsfield's CDN, not ours.** `jobs.output_url` points at Higgsfield's storage and we don't know their retention. If they delete old outputs, "Your videos" shows broken players after a few weeks. Fix: on `completed`, copy the MP4 into Supabase storage (`outputs/<user>/<job>.mp4`, ~5 MB each) and store that URL instead.
- **No "I have permission to use these photos" checkbox** at upload (the Terms require consent, but nothing asks for it). The Accessibility statement names no contact person (Israeli regulations usually expect a named coordinator).
- **Higgsfield balance has no auto top-up or low-balance alert.**
- **Watermarked source clips:** Alors on Danse, Industry Baby, Shrek Raindance.
- **No captcha on sign-in.** Enable Cloudflare Turnstile together with custom SMTP.
- **PayPal live app belongs to a family member's business account (test period).** Before a public launch, move to your own Business account: new live keys, re-register the webhook, update `PAYPAL_*` secrets and `docs/config.js`.
- **Low-risk security leftovers (re-review 2026-10-14).** The Higgsfield callback carries the shared `WEBHOOK_SECRET` in its query string (a per-job HMAC would be better); there's no per-user storage limit (uploads are swept after 7 days by cleanup-inputs); a partial-refund event without `seller_payable_breakdown` claws back only that refund's share.

- **Budget-only trends are enforced on the page only** (2026-10-29, `light_only` in trends.json: thriller, thriller-red-jacket, car-jump-your-car). A crafted request with the full `presets/<slug>.mp4` still renders Premium, correctly priced at the full rate (no underpriced path). Close with a server-side list of light-only slugs in `generate` if it matters.
