// POST {workflow, resolution, prompt, video_url, image_urls, model?} -> {job}
// Prices the request from the video's real length, holds the credits, submits to Higgsfield.
import {
  admin, FALLBACK_USD_PER_SEC, getUser, INPUTS_PUBLIC, isLight, json, LIGHT_MAX_SECS, LIGHT_USD_PER_SEC,
  intEnv, isTester, mp4Duration, PAYMENTS_LIVE, PRESETS_PUBLIC, RESOLUTIONS, serve, submitToHiggsfield, usdToCredits, WORKFLOWS,
} from "../_shared/common.ts";

serve(async (req) => {
  const user = await getUser(req);
  if (!user) return json({ error: "Please sign in first." }, 401);

  const b = await req.json().catch(() => ({}));
  const trend = /^[a-z0-9-]{1,40}$/.test(String(b.trend)) ? String(b.trend) : "custom";
  const workflow = String(b.workflow ?? "");
  const resolution = String(b.resolution ?? "720p");
  const prompt = String(b.prompt ?? "").slice(0, 2000);
  const video_url = String(b.video_url ?? "");
  const image_urls: string[] = Array.isArray(b.image_urls) ? b.image_urls.map(String) : [];
  const ownPrefix = `${INPUTS_PUBLIC}${user.id}/`;
  // Exact shape of an upload (no "../" or extra path segments can sneak into another folder).
  const own = (u: string, ext: string) => u.startsWith(ownPrefix) && new RegExp(`^[A-Za-z0-9_-]{1,64}\\.(${ext})$`, "i").test(u.slice(ownPrefix.length));

  if (!WORKFLOWS.includes(workflow as never)) return json({ error: "Pick a mode." }, 400);
  if (!RESOLUTIONS.includes(resolution as never)) return json({ error: "Pick a resolution." }, 400);
  const isPreset = video_url.startsWith(PRESETS_PUBLIC) && /^[a-z0-9-]+\.mp4$/.test(video_url.slice(PRESETS_PUBLIC.length));
  if (!own(video_url, "mp4|mov") && !isPreset) {
    return json({ error: "Upload a source video." }, 400);
  }
  if (image_urls.length < 1 || image_urls.length > 8 || !image_urls.every((u) => own(u, "jpe?g|png|webp"))) {
    return json({ error: "Add 1–8 reference images." }, 400);
  }

  // Test mode: allowlisted testers can fake the Higgsfield call (mock "ok" or "fail").
  // Credits are still charged and refunded so the whole money path is exercised.
  const mock = b.mock === "ok" || b.mock === "fail" ? b.mock : null;
  if (mock && !isTester(user)) return json({ error: "Test mode is not enabled for this account." }, 403);
  // While payments are in test mode, credits may be fake: only testers may start real renders.
  // Kill switch: set RENDERS_PAUSED=1 to stop every real render immediately.
  if (!mock && Deno.env.get("RENDERS_PAUSED") === "1") return json({ error: "Video generation is paused for maintenance. Please try again later." }, 503);
  if (!mock && !PAYMENTS_LIVE && !isTester(user)) return json({ error: "Video generation isn't open yet. Please check back soon." }, 403);

  // Price from the file itself, never from what the browser says. Higgsfield bills every started
  // second of the source (10.01 s is billed as 11 s), so we round up the same way (1 ms float slack).
  const secs = await mp4Duration(video_url);
  if (secs === null) return json({ error: "We couldn't read that video. Please upload a standard MP4." }, 400);
  if (secs < 3.95) return json({ error: "The video must be at least 4 seconds." }, 400);
  if (secs > 30.001) return json({ error: "The video can be at most 30 seconds. Please trim it." }, 400);
  // Light = a light-* trend preset (picked by file name), or an own upload with model "light".
  const lightUpload = b.model === "light" && !isPreset;
  const light = isLight(video_url) || lightUpload;
  if (light && workflow !== "motion-transfer") {
    return json({ error: lightUpload ? "Light mode only does motion transfer. Choose Stronger for object swap." : "This trend only supports motion transfer." }, 400);
  }
  if (lightUpload && secs > LIGHT_MAX_SECS + 0.001) {
    return json({ error: "Light mode works with videos up to 15 seconds. Trim your video or choose Stronger." }, 400);
  }
  // Light presets must be ≤15 s: Higgsfield bills the source's length too, so a longer one would be undercharged.
  if (light && secs > LIGHT_MAX_SECS + 0.001) { console.error("light preset too long", video_url, secs); return json({ error: "This trend is temporarily unavailable." }, 503); }
  const billed = Math.min(light ? LIGHT_MAX_SECS : 30, Math.max(4, Math.ceil(secs - 0.001)));
  let cost: number;
  try { cost = usdToCredits(light ? LIGHT_USD_PER_SEC[resolution] * billed * 2 : FALLBACK_USD_PER_SEC[resolution] * billed); } catch (e) {
    console.error("pricing refused", e);
    return json({ error: "Video generation is temporarily unavailable." }, 503);
  }
  if (b.quote_only) return json({ cost });
  // Never charge more than the price the visitor was shown (a tab opened before a price change,
  // or an old cached app.js that doesn't send it at all): ask them to reload instead.
  const expected = Number(b.expected_cost);
  if (!Number.isInteger(expected) || cost > expected) {
    return json({ error: "Prices were updated. Please reload the page to see the current price.", cost }, 409);
  }

  // Caps: videos per user per day, and the site's total spend per day (credits, i.e. cents retail).
  const caps = { jobs: intEnv("USER_DAILY_JOBS", 10), user: intEnv("USER_DAILY_CREDITS", 7500), site: intEnv("SITE_DAILY_CREDITS", 15000) };
  if (caps.jobs === null || caps.user === null || caps.site === null) {
    console.error("cap settings invalid", caps);
    return json({ error: "Video generation is temporarily unavailable." }, 503);
  }
  const { data: res, error } = await admin.rpc("create_job", {
    p_user: user.id, p_trend: trend, p_workflow: workflow, p_resolution: resolution, p_prompt: prompt,
    p_video_url: video_url, p_image_urls: image_urls, p_cost: cost, p_billed_secs: billed, p_mock: !!mock,
    p_user_daily_jobs: caps.jobs, p_user_daily_credits: caps.user, p_site_daily_credits: caps.site,
    p_model: light ? "light" : "full",
  }).single<{ job_id: string | null; reason: string | null }>();
  if (error || !res) { console.error("create_job failed", error); return json({ error: "Could not create job." }, 500); }
  if (res.reason === "no_credits") return json({ error: "Not enough credits.", cost }, 402);
  if (res.reason === "frozen") return json({ error: "Your account is on hold because of a payment dispute. Contact us to resolve it." }, 403);
  if (res.reason === "user_limit") return json({ error: "You've reached today's limit of videos. Please try again tomorrow." }, 429);
  if (res.reason === "site_limit") {
    console.warn("site daily spend cap reached");
    return json({ error: "We're at capacity for today. Please try again tomorrow. You were not charged." }, 503);
  }
  if (res.reason === "bad_config") { console.error("create_job: bad cap config"); return json({ error: "Video generation is temporarily unavailable." }, 503); }
  if (!res.job_id) return json({ error: "Could not create job." }, 500);
  const { data: job } = await admin.from("jobs").select("*").eq("id", res.job_id).single();
  if (!job) {
    await admin.from("jobs").update({ status: "failed", error: "Could not start." }).eq("id", res.job_id);
    await admin.rpc("refund_job", { p_job: res.job_id });
    return json({ error: "Could not create job. Your credits were refunded." }, 500);
  }

  // The visitor ticked "I understand… / I agree to the Terms" before Generate (sent by app.js since 2026-10-29;
  // older pages don't send it, so it's recorded, never required). Evidence for payment disputes.
  if (b.terms_ok === true) {
    const { error: tErr } = await admin.from("jobs").update({ terms_accepted_at: new Date().toISOString() }).eq("id", job.id);
    if (tErr) console.error("terms_accepted_at not saved", job.id, tErr.message);
  }

  if (mock) {
    const { data: saved } = await admin.from("jobs")
      .update({ hf_request_id: `mock:${mock}:${job.id}`, status: "queued", updated_at: new Date().toISOString() })
      .eq("id", job.id).select().single();
    return json({ job: saved });
  }

  const fail = async (msg: string, status: number) => {
    await admin.from("jobs").update({ status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("id", job.id);
    await admin.rpc("refund_job", { p_job: job.id });
    return json({ error: `${msg} Your credits were refunded.` }, status);
  };

  const sub = await submitToHiggsfield(job);
  if (sub.ok === false && sub.fatal) {
    return fail("The video or photos weren't accepted. Check the video is 4–30s MP4 and try again.", 400);
  }
  if (sub.ok === false) {
    // No clear answer: Higgsfield may be rendering it. Hold the credits; the owner reconciles it
    // by hand (daily report flags it) and either attaches the render or refunds.
    console.error("SUBMIT_UNKNOWN: reconcile by hand", job.id);
    const { data: held } = await admin.from("jobs")
      .update({ status: "submit_unknown", error: "We're checking on this video. If it didn't run, your credits will be refunded within a day.", updated_at: new Date().toISOString() })
      .eq("id", job.id).select().single();
    return json({ job: held ?? job });
  }

  const { data: saved } = await admin.from("jobs")
    .update({ hf_request_id: sub.request_id, status: sub.status, updated_at: new Date().toISOString() })
    .eq("id", job.id).select().single();
  return json({ job: saved });
});
