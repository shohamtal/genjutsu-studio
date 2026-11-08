# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Personal project of Shoham (genjutsu-trends.com), not Revuze: personal GitHub only, direct commits to `main`.

## Mandatory rules

### Security review gate
Every code, config, DB-migration, storage-content or secret change must be reviewed by a security agent **before** it is
committed+pushed, deployed (`supabase functions deploy`, GitHub Pages) or applied (SQL, secrets, Supabase Auth config).
- Spawn a fresh security-reviewer agent with the diff (`git diff`) and the context of what changed and why.
- Proceed only after it returns an explicit **ACCEPT**. Fix every finding and re-submit until it accepts.
- No exceptions for "small" or "copy-only" changes. If the review can't run, don't ship; tell Shoham.
- Fixed check on every new or changed scene video (`presets/*.mp4`, full and `light-*`): the reviewer runs
  `ffprobe -show_entries stream=duration:format=duration` and rejects any file whose longest track runs a fraction past
  a whole second by 0.001–0.05 s (e.g. 15.015 s). Higgsfield bills every started second, so such a file costs us a
  second we don't charge for. Trim it to end on or just under the whole second. `light-*` files must be ≤ 15.000 s.

### Deploys must not break users mid-action
- Stay backward compatible with what's live: apply DB migrations first and keep them additive (never drop or rename
  in the same deploy); server code must accept requests from the previous `app.js`; the frontend must work against
  the previous server for the few minutes Pages takes.
- Right before deploying, check nothing is in flight: no jobs in `submitting` and no PayPal order created in the
  last 5 minutes that isn't completed (`select ... from jobs where status='submitting'`,
  `select ... from payments where status='created' and created_at > now()-interval '5 minutes'`). If there is, wait.
- After deploying, re-check those queries and the latest jobs/payments; if anything got stuck, reconcile it (README).
- Credits move only inside single-transaction RPCs (`create_job`, `complete_payment`, `refund_job`, `claw_payment`,
  `charge_surcharge`); never split a credit change across two calls.
- Before switching a production integration (e.g. SMTP, PayPal keys), test the provider directly first, and have
  the revert ready.

Background: on 2026-10-15..19 the public site ran on sandbox PayPal; strangers paid with fake sandbox cards and
started real (paid) Higgsfield renders.

### User videos: the public feed (since 2026-11-08)
- A video is on the home-page feed only while its owner ticked "Publish to the main feed" on My videos
  (`jobs.published_at` set), it isn't deleted (`hidden_at` null) and not removed after a report (`removed_at` null).
  It shows at once (Shoham's decision). The consent covers the video, its prompt, the source video and the photos,
  and anyone can Recreate it with them (`/custom/?from=<id>`).
- Publishing copies the output, the source and the photos to the public `feed` bucket (`feed/<job id>/`), so they
  outlive the 7-day upload cleanup. Unpublish/delete/removal delete that folder. Only own uploads can be published:
  never a trend scene (`presets/`). The old `gallery_opt_in_at` consent (narrower) never publishes anything.
- Reports (`report` function, public) wait for review: the post stays up until Shoham presses Remove or Dismiss in
  the admin dashboard (`moderate` function, `MODERATION_SECRET`). 3 removals = the account can't publish.
- The feed is not indexed: no per-post pages, nothing in the sitemap or JSON-LD.
- No DMCA page or agent for now (Shoham's call); don't add DMCA wording without asking.

## Commands
- Build the site: `python3 site/build.py` (regenerates every page in `docs/`, the sitemap and robots.txt).
- Type-check an edge function: `deno check supabase/functions/<name>/index.ts`
  (if a parent folder has `node_modules`, add `--node-modules-dir=none` when running Deno scripts).
- Deploy edge functions: `supabase functions deploy <name> --project-ref tbljgxkbocunzoqvkoeu --use-api`
  (`--use-api` is required: Docker bundling fails; source `~/.claude/.env` for `SUPABASE_ACCESS_TOKEN`).
- Run SQL / apply a migration: POST it to the Management API
  `https://api.supabase.com/v1/projects/tbljgxkbocunzoqvkoeu/database/query` (build the JSON body with Python to
  avoid quoting errors).
- Deploy the frontend: commit + push `main`; GitHub Pages serves `docs/`. A failed Pages run (HTTP 500) just needs
  `gh run rerun <id>`.
- There is no test suite. Verify with: `deno check`; a free end-to-end run as a tester (`?mock=ok` / `?mock=fail`
  on any studio page, `TEST_EMAILS` only; never calls Higgsfield); and Playwright in a real browser
  (desktop + 390 px, no console errors, `scrollWidth` = viewport).

## Architecture

### Frontend (`docs/`, static, GitHub Pages)
- Hand-written: `docs/app.js` (all client logic), `docs/config.js` (public config, display-only prices),
  `docs/styles.css`, `docs/goatcounter.js` (self-hosted, query-stripped analytics),
  `docs/vendor-supabase.js` (self-hosted, pinned supabase-js UMD). Everything else in `docs/` is generated.
- `site/build.py` renders every page from `site/trends.json` (one entry per trend: scene URL, duration, mode, prompt,
  photo slots, SEO copy, FAQ), `site/genjutsu_*`, and `site/legal/*.html`. Edit `site/`, never the generated HTML.
  `ASSET_VER` (hash of app.js/styles.css/config.js) cache-busts assets.
- Trends are static pages by design (search engines and ChatGPT send traffic); there is no trends table. Adding a
  trend = upload `presets/<slug>.mp4` to the public Supabase `presets` bucket, add `docs/trends/<slug>/`
  `poster.jpg` / `preview.mp4` / `og.jpg`, add the `trends.json` entry, rebuild, push. Hidden trends (`qa-4s`) get a
  page but stay out of the gallery and sitemap.
- Trend prompts (every new trend and every rewrite): say what you replace (the character, by outfit and position),
  what it becomes (the person in the first / second … uploaded picture, in `image_urls` order) and what stays
  (lighting, setting, outfits, facial expressions, moves, camera, timing, or "Keep everything else as filmed").
  The source video controls motion, camera and framing. Slot hints ask for clean, neutral photos (a photo's lighting
  and background leak into the result). Genjutsu Light (API) trims the source to 15 s and drifts on anything the
  prompt doesn't list.
- Sign-in is a 6-digit email code (`EMAIL_CODE: true`), sent by Supabase Auth through Resend SMTP from
  `login@genjutsu-trends.com`. Photos added before sign-in survive via an IndexedDB draft.

### Backend (Supabase project `tbljgxkbocunzoqvkoeu`, `supabase/`)
- `_shared/common.ts`: auth, CORS, pricing (`usdToCredits`: list price × `HF_DISCOUNT` × `MARKUP` × 100 + fee,
  range-checked), `mp4Duration` (prices from the uploaded file's own boxes incl. per-track sample tables; rejects
  fragmented/forged files), `submitToHiggsfield` (exactly one POST per job, no retries), `syncJob` (status, refunds,
  surcharge if the output ran longer than billed).
- `generate`: validates inputs (own `inputs/<uid>/` uploads, a `presets/<slug>.mp4`, or a live feed post's source and
  photos for a Recreate), live-payments gate,
  kill switch `RENDERS_PAUSED`, prices, rejects if the client's `expected_cost` is lower (409), then `create_job`
  (atomic credit hold + per-user and site-wide daily caps). Unclear submit outcomes become `submit_unknown` and are
  reconciled by hand (runbook in README).
- `jobs` (polling) and `hf-webhook` both re-read status from Higgsfield. `paypal` creates/captures orders;
  `paypal-webhook` (signature-verified) handles completed/refunded/reversed/denied captures and disputes (freeze).
  `daily-report` and `cleanup-inputs` are called with `REPORT_SECRET` by the private ops repo.
- DB: `profiles` (credits, may go negative as debt; `frozen`), `payments`, `jobs`, `job_debug` (owner-only raw
  provider replies). Clients only SELECT their own rows; all writes go through edge functions / security-definer RPCs.
  Storage: `inputs` (private, uploads kept 7 days), `presets` (public trend scenes), `feed` (public, published posts).
- Feed: `feed` (public list / one post), `report` (public), `moderate` (secret, admin dashboard only),
  `_shared/feed.ts` (copy to / delete from the feed bucket). Table `reports`; `profiles.strikes`, `publish_banned_at`.

### Elsewhere
- Private repo `~/repos2/genjutsu-ops` (GitHub `shohamtal/genjutsu-ops`): daily report workflow (opens an issue,
  flags anomalies, runs the upload cleanup) and the local-only admin dashboard (`admin/start.sh`, 127.0.0.1:8790,
  read-only).
- `.github/workflows/`: `supabase-keepalive.yml` (pings the `keepalive` view so the free project doesn't pause),
  `indexnow.yml` (pings Bing/IndexNow with the sitemap after every `docs/` push).
- DNS is on Cloudflare (`CLOUDFLARE_TOKEN` in `~/.claude/.env` has DNS-edit only). PayPal is live on a family
  member's business account during the test period. `OPEN_ISSUES.md` lists known gaps deliberately left open.
