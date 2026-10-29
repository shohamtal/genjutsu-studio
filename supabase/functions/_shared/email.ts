// "Your video is ready" / "didn't come out" emails, sent once per job through Resend.
// Service emails about the user's own order (no marketing, so no opt-in needed).
import { admin, REAL_PERSON_ERROR } from "./common.ts";

const SITE = "https://genjutsu-trends.com/";
const FROM = "Genjutsu <login@genjutsu-trends.com>";
const REPLY_TO = "support@genjutsu-trends.com";

type MailJob = { id: string; user_id?: string; trend?: string; status: string; cost?: number; error?: string | null };

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Trend display names come from the public site (built from site/trends.json); cached per instance.
let names: Record<string, string> | null = null;
async function trendName(slug: string): Promise<string> {
  if (slug === "custom") return "custom";
  if (!names) {
    names = await fetch(`${SITE}trend-names.json`, { signal: AbortSignal.timeout(5000) }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  }
  return names?.[slug] ?? slug.replace(/-/g, " ");
}

function shell(ref: "email-ready" | "email-failed", preheader: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light dark"></head>
<body style="margin:0;padding:0;background:#f3f1f8;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f1f8;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#15121f;">
<tr><td style="background:#0b0b10;padding:16px 24px;font-size:18px;font-weight:700;color:#ffffff;">🌀 Genjutsu <span style="color:#a78bfa;font-weight:600">Trends</span></td></tr>
${body}
<tr><td style="padding:18px 24px 24px;border-top:1px solid #eee;font-size:12px;line-height:1.5;color:#8a8696;">
You're getting this because you made a video on <a href="${SITE}?ref=${ref}" style="color:#8a8696;">genjutsu-trends.com</a>. Questions? Reply to <a href="mailto:${REPLY_TO}" style="color:#8a8696;">${REPLY_TO}</a>.<br>
Independent service, not affiliated with Higgsfield AI.</td></tr>
</table></td></tr></table></body></html>`;
}
const btn = (href: string, label: string) =>
  `<a href="${href}" style="display:inline-block;background:linear-gradient(90deg,#8b5cf6,#ec4899);background-color:#8b5cf6;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 26px;border-radius:12px;">${label}</a>`;

function readyMail(name: string, slug: string) {
  const n = esc(name);
  const img = slug === "custom" ? `${SITE}og.jpg` : `${SITE}trends/${encodeURIComponent(slug)}/og.jpg`;
  return {
    subject: `Your ${name} video is ready 🎬`,
    html: shell("email-ready", "Watch it, download it, and post it.", `
<tr><td style="padding:0;"><a href="${SITE}my-videos/?ref=email-ready"><img src="${img}" width="560" alt="Your ${n} video" style="display:block;width:100%;height:auto;border:0;"></a></td></tr>
<tr><td style="padding:24px 24px 8px;">
<h1 style="margin:0 0 10px;font-size:24px;line-height:1.25;">Your ${n} video is ready 🎬</h1>
<p style="margin:0 0 20px;font-size:16px;line-height:1.5;color:#4a4658;">It took a few minutes, and it's waiting for you. Watch it, download the MP4 and post it.</p>
<p style="margin:0 0 22px;">${btn(`${SITE}my-videos/?ref=email-ready`, "▶ Watch &amp; download")}</p>
<p style="margin:0 0 6px;font-size:14px;line-height:1.5;color:#4a4658;">Tip: download it to keep a copy. Videos may not stay online forever.</p>
</td></tr>
<tr><td style="padding:8px 24px 22px;">
<table role="presentation" width="100%" style="background:#f7f5fc;border-radius:12px;"><tr><td style="padding:14px 16px;font-size:15px;line-height:1.5;">
<b>Make another one?</b> More trends are waiting. <a href="${SITE}?ref=email-ready" style="color:#7c3aed;font-weight:600;">Browse trends →</a>
</td></tr></table></td></tr>`),
  };
}

function failedMail(name: string, slug: string, status: string, credits: number, error?: string | null) {
  const n = esc(name);
  const c = credits.toLocaleString("en-US");
  const why = status === "nsfw" && error === REAL_PERSON_ERROR
    ? "Our provider blocks photos of famous people and public figures (for example pictures of celebrities found online), so we didn't make it."
    : status === "nsfw"
    ? "The video was blocked by the automatic content check, so we didn't make it."
    : "The render failed on our provider's side, so we didn't make it.";
  const retry = slug === "custom" ? `${SITE}custom/?ref=email-failed` : `${SITE}trends/${encodeURIComponent(slug)}/?ref=email-failed`;
  return {
    subject: `Your ${name} video didn't come out`,
    html: shell("email-failed", `Your ${c} credits are back in your account.`, `
<tr><td style="padding:24px 24px 8px;">
<h1 style="margin:0 0 10px;font-size:24px;line-height:1.25;">Your ${n} video didn't come out</h1>
<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:#4a4658;">${why} <b>Your ${c} credits are back in your account</b>, so you can try again for free.</p>
<p style="margin:0 0 8px;font-size:15px;font-weight:600;">What usually works:</p>
<ul style="margin:0 0 20px;padding-left:20px;font-size:15px;line-height:1.6;color:#4a4658;">
<li>Your own photos, not pictures of celebrities from the internet</li>
<li>One person per photo, facing the camera, in good light</li>
<li>No sunglasses, masks or heavy filters</li>
<li>Only use photos of people who agreed to be in the video</li>
</ul>
<p style="margin:0 0 22px;">${btn(retry, "Try again")}</p>
</td></tr>`),
  };
}

/**
 * Email the job's owner about its final state, at most once per job: claiming jobs.notified_at with a
 * conditional update means concurrent syncs (polling + webhook) can't both send. Never throws.
 */
export async function notifyJobDone(job: MailJob) {
  try {
    const key = Deno.env.get("RESEND_API_KEY");
    if (!key || !job.user_id) return;
    const ok = job.status === "completed";
    const bad = ["failed", "nsfw", "canceled"].includes(job.status);
    if (!ok && !bad) return;
    const { data: claimed } = await admin.from("jobs").update({ notified_at: new Date().toISOString() })
      .eq("id", job.id).is("notified_at", null).select("id");
    if (!claimed?.length) return; // already sent (or being sent) by another sync
    const { data: u } = await admin.auth.admin.getUserById(job.user_id);
    const to = u?.user?.email;
    if (!to) return;
    const slug = /^[a-z0-9-]{1,40}$/.test(job.trend ?? "") ? job.trend! : "custom";
    const name = await trendName(slug);
    const mail = ok ? readyMail(name, slug) : failedMail(name, slug, job.status, job.cost ?? 0, job.error);
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `job-${job.id}` },
      body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, subject: mail.subject, html: mail.html }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) console.error("job email failed", job.id, r.status); // no body: it can echo the address
  } catch (e) {
    console.error("job email error", job.id, e);
  }
}
