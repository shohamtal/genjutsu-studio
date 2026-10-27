import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const ORIGINS = (Deno.env.get("ALLOWED_ORIGIN") ?? "https://genjutsu-trends.com").split(",").map((s) => s.trim());

function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allow = ORIGINS.includes("*") ? "*" : ORIGINS.includes(origin) ? origin : ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    Vary: "Origin",
  };
}

/** Deno.serve with CORS preflight + CORS headers on every response. */
export function serve(handler: (req: Request) => Promise<Response>) {
  Deno.serve(async (req) => {
    const cors = corsFor(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    const res = await handler(req);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export const admin: SupabaseClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

/** True only when PayPal is live. Anything else (unset, "sandbox", typo) counts as test mode. */
export const PAYMENTS_LIVE = Deno.env.get("PAYPAL_ENV") === "live";

/** Allowlisted test accounts (TEST_EMAILS, comma-separated). */
export function isTester(user: { email?: string | null; email_confirmed_at?: string | null }): boolean {
  const list = (Deno.env.get("TEST_EMAILS") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  return !!user.email && !!user.email_confirmed_at && list.includes(user.email.toLowerCase());
}

/** Integer setting from a secret, with a default when unset. Anything else (typo, "3,000") is null. */
export function intEnv(name: string, def: number): number | null {
  const raw = Deno.env.get(name);
  if (raw === undefined) return def;
  const n = Number(raw.trim());
  return raw.trim() !== "" && Number.isInteger(n) && n >= 1 ? n : null;
}

/** Resolve the calling user from the bearer token, or null. */
export async function getUser(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  return error ? null : data.user;
}

// ---------- Higgsfield ----------
export const HF_BASE = "https://api.higgsfield.ai";
export const WORKFLOWS = ["motion-transfer", "object-swap"] as const;
export const RESOLUTIONS = ["480p", "720p", "1080p"] as const;
// USD per second of output, used only when the estimate endpoint is unavailable.
export const FALLBACK_USD_PER_SEC: Record<string, number> = { "480p": 0.318, "720p": 0.681, "1080p": 1.632 };
// Genjutsu Light (motion transfer only, uses the first 15 s). It bills output seconds PLUS the source
// video's seconds, so a job costs rate x 2 x seconds. Chosen only by the server, from the preset's name:
// presets/light-<slug>.mp4, or by the visitor for an own upload of up to 15 s (stored as jobs.model).
export const LIGHT_USD_PER_SEC: Record<string, number> = { "480p": 0.05, "720p": 0.10, "1080p": 0.20 };
export const LIGHT_MAX_SECS = 15;
export const TERMINAL = new Set(["completed", "failed", "nsfw", "canceled"]);

export function hfHeaders(extra: Record<string, string> = {}) {
  return {
    Authorization: `Key ${Deno.env.get("HF_API_KEY_ID")}:${Deno.env.get("HF_API_KEY_SECRET")}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

/** 1 credit = $0.01 retail. Retail = list cost x HF_DISCOUNT x MARKUP + FEE_USD per video. */
export function usdToCredits(usd: number): number {
  const discount = Number(Deno.env.get("HF_DISCOUNT") ?? "1");
  const markup = Number(Deno.env.get("MARKUP") ?? "1.5");
  const fee = Number(Deno.env.get("FEE_USD") ?? "0");
  // A typo'd secret (e.g. MARKUP=0) must not silently sell renders for pennies: refuse to price.
  if (!(discount > 0 && discount <= 1) || !(markup >= 1 && markup <= 10) || !(fee >= 0 && fee <= 20) || !(usd > 0)) {
    throw new Error("pricing config out of range");
  }
  // -1e-9 keeps float noise (20 x 0.318 x 1.5 x 100 = 954.0000000001) from adding a credit; matches app.js.
  return Math.max(1, Math.ceil(usd * discount * markup * 100 - 1e-9) + Math.round(fee * 100));
}

// ---------- storage ----------
const SB_URL = Deno.env.get("SUPABASE_URL")!;
export const INPUTS_PUBLIC = `${SB_URL}/storage/v1/object/public/inputs/`; // URL shape the client sends
export const PRESETS_PUBLIC = `${SB_URL}/storage/v1/object/public/presets/`;
export const isLight = (videoUrl?: string) => !!videoUrl && videoUrl.startsWith(`${PRESETS_PUBLIC}light-`);
const srk = () => Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** Object path inside the private "inputs" bucket for a client-sent URL, or null. */
export const inputPath = (url: string) => (url.startsWith(INPUTS_PUBLIC) ? url.slice(INPUTS_PUBLIC.length) : null);

/** Short-lived signed URL Higgsfield can fetch a private input from. */
export async function signInput(path: string): Promise<string> {
  const { data, error } = await admin.storage.from("inputs").createSignedUrl(path, 6 * 3600);
  if (error || !data) throw new Error(`sign failed: ${error?.message}`);
  return data.signedUrl;
}

/**
 * Delete a job's uploads now. Normal cleanup is the retention sweep (cleanup-inputs, INPUT_RETENTION_DAYS),
 * which keeps uploads a few days so the owner can reproduce a failed render.
 */
export async function deleteInputs(job: { video_url?: string; image_urls?: unknown }) {
  const urls = [job.video_url, ...(Array.isArray(job.image_urls) ? job.image_urls : [])].map(String);
  const paths = urls.map(inputPath).filter((x): x is string => !!x);
  if (paths.length) await admin.storage.from("inputs").remove(paths).catch(() => {});
}

/**
 * Duration in seconds of an MP4/MOV, read from its moov/mvhd box with ranged GETs, so the
 * price never depends on what the browser claims. Returns null if it can't be read.
 */
export async function mp4Duration(url: string): Promise<number | null> {
  const path = inputPath(url);
  const src = path ? `${SB_URL}/storage/v1/object/authenticated/inputs/${path}` : url;
  const headers = path ? { Authorization: `Bearer ${srk()}`, apikey: srk() } : {};
  const range = async (from: number, to: number) => {
    const r = await fetch(src, { headers: { ...headers, Range: `bytes=${from}-${to}` } });
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  };
  let off = 0;
  for (let i = 0; i < 64; i++) {
    const h = await range(off, off + 15);
    if (!h || h.length < 8) return null;
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let size = dv.getUint32(0);
    const type = String.fromCharCode(...h.slice(4, 8));
    let hdr = 8;
    if (size === 1) { if (h.length < 16) return null; size = Number(dv.getBigUint64(8)); hdr = 16; }
    if (size < hdr) return null; // size 0 ("to end of file") never wraps a moov we can find
    if (type === "moov") {
      if (size > 8 * 1024 * 1024) return null; // a 30s clip's index is far smaller; don't price a partial read
      const moov = await range(off + hdr, off + size - 1);
      return moov ? moovDuration(moov) : null;
    }
    off += size;
  }
  return null;
}

/**
 * Presented length of the movie: the longest of the movie header and each track header.
 * The uploader controls those headers, so each track is also checked against what it really
 * contains: the sum of its sample durations (stts). If a track carries more than 2s beyond
 * the presented length, or a video track runs faster than 120 fps (frames squeezed into short
 * timestamps), the file is rejected rather than priced. Fragmented MP4s (mvex) are rejected too.
 */
function moovDuration(moov: Uint8Array): number | null {
  let movieScale = 0, presented = 0;
  const tracks: { media: number; samples: number; video: boolean; edited: boolean }[] = [];
  const box = (j: number, end: number) => {
    if (j + 8 > end) return null;
    const m = new DataView(moov.buffer, moov.byteOffset + j, end - j);
    const size = m.getUint32(0);
    if (size < 8 || j + size > end) return "bad" as const;
    return { m, size, type: String.fromCharCode(...moov.slice(j + 4, j + 8)), v: moov[j + 8] };
  };
  // Walk the children of [start, end); returns false on any malformed or truncated box.
  const each = (start: number, end: number, fn: (b: { m: DataView; size: number; type: string; v: number }, at: number) => boolean) => {
    for (let j = start; j < end;) {
      const b = box(j, end);
      if (b === null) return end - j === 0;
      if (b === "bad") return false;
      if (!fn(b, j)) return false;
      j += b.size;
    }
    return true;
  };
  const hd = (b: { m: DataView; v: number }) => // mvhd/mdhd: [timescale, duration]
    b.v === 1 ? [b.m.getUint32(28), Number(b.m.getBigUint64(32))] : [b.m.getUint32(20), b.m.getUint32(24)];

  const ok = each(0, moov.length, (b, j) => {
    if (b.type === "mvex") return false;
    if (b.type === "mvhd") {
      const [ts, d] = hd(b);
      if (!ts) return false;
      movieScale = ts;
      presented = Math.max(presented, d / ts);
    } else if (b.type === "trak") {
      if (!movieScale) return false;
      const t = { media: 0, samples: 0, video: false, edited: false };
      let scale = 0, ticks = 0;
      const good = each(j + 8, j + b.size, (c, k) => {
        if (c.type === "edts") t.edited = true;
        if (c.type === "tkhd") presented = Math.max(presented, (c.v === 1 ? Number(c.m.getBigUint64(36)) : c.m.getUint32(28)) / movieScale);
        if (c.type !== "mdia") return true;
        return each(k + 8, k + c.size, (e, l) => {
          if (e.type === "mdhd") { const [ts] = hd(e); scale = ts; }
          if (e.type === "hdlr") t.video = String.fromCharCode(...moov.slice(l + 16, l + 20)) === "vide";
          if (e.type !== "minf") return true;
          return each(l + 8, l + e.size, (f, n) => f.type !== "stbl" ? true : each(n + 8, n + f.size, (g, q) => {
            if (g.type !== "stts") return true;
            const entries = g.m.getUint32(12);
            if (16 + entries * 8 > g.size) return false;
            for (let i = 0; i < entries; i++) {
              const count = g.m.getUint32(16 + i * 8), delta = g.m.getUint32(20 + i * 8);
              t.samples += count; ticks += count * delta;
            }
            return true;
          }));
        });
      });
      if (!good || !scale) return false;
      t.media = ticks / scale;
      if (!t.edited) presented = Math.max(presented, t.media);
      tracks.push(t);
    }
    return true;
  });
  if (!ok || !movieScale || !tracks.length) return null;
  for (const t of tracks) {
    if (t.media > presented + 2) return null;
    if (t.video && t.samples / Math.max(t.media, 0.001) > 120) return null;
  }
  return presented;
}

/** Owner-only record of the provider's raw replies (table job_debug, unreadable by clients). */
async function saveDebug(jobId: string, fields: Record<string, unknown>) {
  const { error } = await admin.from("job_debug").upsert({ job_id: jobId, ...fields, updated_at: new Date().toISOString() });
  if (error) console.error("saveDebug failed", jobId, error.message);
}

type Submit = { ok: true; request_id: string; status: string } | { ok: false; fatal: boolean };

/**
 * Send a job to Higgsfield exactly once. Higgsfield doesn't document whether it de-duplicates on
 * Idempotency-Key, so a resubmit could start a second paid render: we never retry.
 * fatal = Higgsfield clearly rejected it (4xx) or we never sent it: refund. Otherwise (network error,
 * 5xx, a reply without request_id) it may be rendering: the caller holds the credits for review.
 */
export async function submitToHiggsfield(job: Job): Promise<Submit> {
  let input;
  try { // uploads live in a private bucket: hand Higgsfield short-lived signed URLs
    const sign = (u: string) => (inputPath(u) ? signInput(inputPath(u)!) : Promise.resolve(u));
    const images = (Array.isArray(job.image_urls) ? job.image_urls : []).map(String);
    input = { video_url: await sign(String(job.video_url)), image_urls: await Promise.all(images.map(sign)), prompt: job.prompt ?? "", resolution: job.resolution };
  } catch (e) {
    console.error("signing failed", job.id, e);
    return { ok: false, fatal: true }; // nothing was sent
  }
  const hook = `${SB_URL}/functions/v1/hf-webhook?secret=${Deno.env.get("WEBHOOK_SECRET")}`;
  try {
    const endpoint = job.model === "light" || isLight(job.video_url) ? "higgsfield/genjutsu-light/motion-transfer/v1.0" : `higgsfield/genjutsu/${job.workflow}/v1.0`;
    const r = await fetch(`${HF_BASE}/${endpoint}?hf_webhook=${encodeURIComponent(hook)}`, {
      method: "POST", headers: hfHeaders({ "Idempotency-Key": job.id }), body: JSON.stringify(input),
    });
    const sub = await r.json().catch(() => ({}));
    if (r.ok && sub.request_id) return { ok: true, request_id: String(sub.request_id), status: String(sub.status ?? "queued") };
    console.error("higgsfield submit failed", job.id, r.status, JSON.stringify(sub).slice(0, 500));
    await saveDebug(job.id, { submit_status: r.status, submit_body: JSON.stringify(sub).slice(0, 4000) });
    return { ok: false, fatal: r.status >= 400 && r.status < 500 };
  } catch (e) {
    console.error("higgsfield submit threw", job.id, e);
    await saveDebug(job.id, { submit_body: `network error: ${String(e).slice(0, 1000)}` });
    return { ok: false, fatal: false };
  }
}

// Moderation messages users see (on My videos and in the email). We map Higgsfield's reason to our own text
// instead of showing it raw, so a provider message can never carry anything odd to the user.
export const REAL_PERSON_ERROR =
  "Higgsfield blocks photos of famous people and public figures. Use your own photos (one person each, facing the camera). Your credits were refunded.";
const MODERATION_ERROR = "Higgsfield's content check blocked this video. Your credits were refunded.";
export const moderationError = (reason: unknown) =>
  /real person|public figure|celebrit|famous/i.test(String(reason ?? "")) ? REAL_PERSON_ERROR : MODERATION_ERROR;

/** Fetch status from Higgsfield, persist it on the job, refund on failure. */
export async function syncJob(job: Job) {
  if (TERMINAL.has(job.status)) return job;
  if (!job.hf_request_id) return job; // submitting, or submit_unknown awaiting manual review
  if (job.hf_request_id.startsWith("mock:")) return syncMockJob(job);
  const r = await fetch(`${HF_BASE}/requests/${job.hf_request_id}/status`, { headers: hfHeaders() });
  if (!r.ok) return job;
  const s = await r.json();
  const patch: Record<string, unknown> = { status: s.status, updated_at: new Date().toISOString() };
  if (s.video?.url) patch.output_url = s.video.url;
  if (s.error) { // users see a plain message; the provider's raw text stays in the logs
    console.error("higgsfield job failed", job.id, String(s.error).slice(0, 500));
    patch.error = "The render failed. Your credits were refunded.";
  }
  if (s.status === "nsfw") patch.error = moderationError(s.error);
  if (["failed", "nsfw", "canceled"].includes(s.status)) await saveDebug(job.id, { final_body: JSON.stringify(s).slice(0, 4000) });
  const { data } = await admin.from("jobs").update(patch).eq("id", job.id).select().single();
  if (["failed", "nsfw", "canceled"].includes(s.status)) await admin.rpc("refund_job", { p_job: job.id });
  if (TERMINAL.has(s.status) && data) await (await import("./email.ts")).notifyJobDone(data); // once per job
  if (s.status === "completed" && s.video?.url && job.billed_secs && job.cost) { // pricing check on the real output
    const out = await mp4Duration(s.video.url).catch(() => null);
    const secs = out === null ? null : Math.min(30, Math.ceil(out - 0.05));
    if (secs !== null && secs > job.billed_secs) {
      const extra = Math.ceil((job.cost / job.billed_secs) * (secs - job.billed_secs));
      const { data: took } = await admin.rpc("charge_surcharge", { p_job: job.id, p_credits: extra });
      console.warn("output longer than billed: surcharge", job.id, out, job.billed_secs, took);
    }
  }
  return data ?? job;
}

type Job = {
  id: string; hf_request_id: string | null; status: string; created_at?: string; updated_at?: string;
  video_url?: string; image_urls?: unknown; billed_secs?: number | null; cost?: number;
  workflow?: string; resolution?: string; prompt?: string; mock?: boolean; model?: string;
};
const MOCK_OUTPUT = `${PRESETS_PUBLIC}qa-4s.mp4`;

/** Test-mode jobs: queued -> in_progress -> completed/failed over ~20s, no Higgsfield call. */
async function syncMockJob(job: Job) {
  const age = Date.now() - new Date(job.created_at ?? Date.now()).getTime();
  const fail = job.hf_request_id!.startsWith("mock:fail");
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (age < 8000) patch.status = "queued";
  else if (age < 20000) patch.status = "in_progress";
  else if (fail) Object.assign(patch, { status: "failed", error: "Test mode: simulated failure. Your credits were refunded." });
  else Object.assign(patch, { status: "completed", output_url: MOCK_OUTPUT });
  const { data } = await admin.from("jobs").update(patch).eq("id", job.id).select().single();
  if (patch.status === "failed") await admin.rpc("refund_job", { p_job: job.id });
  if (TERMINAL.has(String(patch.status)) && data) await (await import("./email.ts")).notifyJobDone(data);
  return data ?? job;
}

/** Constant-time string compare for shared secrets. */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}
