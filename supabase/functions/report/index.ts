// POST {post, kind, email, details} (public, no sign-in) -> {ok}
// Anyone can report a feed post. The post stays up until the owner reviews it in the admin dashboard
// (moderate edge function). One report per email per post; global and per-email rate limits.
import { admin, json, serve } from "../_shared/common.ts";
import { isUuid } from "../_shared/feed.ts";

const KINDS = ["copyright", "consent", "other"];
const SUPPORT = "support@genjutsu-trends.com";
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const b = await req.json().catch(() => ({}));
  const post = b.post, kind = String(b.kind ?? "");
  const email = String(b.email ?? "").trim().toLowerCase().slice(0, 254);
  const details = Array.from(String(b.details ?? "").trim()).slice(0, 2000).join("");
  if (!isUuid(post)) return json({ error: "Video not found." }, 404);
  if (!KINDS.includes(kind)) return json({ error: "Pick a reason." }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Enter a valid email, so we can reply." }, 400);
  if (details.length < 10) return json({ error: "Tell us a bit more (at least 10 characters)." }, 400);

  const { data: job } = await admin.from("jobs").select("id")
    .eq("id", post).not("published_at", "is", null).is("hidden_at", null).is("removed_at", null).maybeSingle();
  if (!job) return json({ error: "Video not found." }, 404);

  // Rate limits: per email, per IP (stored only as a salted hash) and site-wide.
  // The platform appends the real client IP last; earlier entries are client-controlled.
  const ip = req.headers.get("cf-connecting-ip") ?? (req.headers.get("x-forwarded-for") ?? "").split(",").pop()!.trim();
  const salt = Deno.env.get("REPORT_IP_SALT") ?? ""; // secret; without it no IP hash is stored
  const ipHash = ip && salt.length >= 32 ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|${ip}`))))
    .map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32) : null;
  const hourAgo = new Date(Date.now() - 3600_000).toISOString(), dayAgo = new Date(Date.now() - 86400_000).toISOString();
  const [{ count: all }, { count: mine }, { count: fromIp }] = await Promise.all([
    admin.from("reports").select("id", { count: "exact", head: true }).gt("created_at", hourAgo),
    admin.from("reports").select("id", { count: "exact", head: true }).eq("email", email).gt("created_at", dayAgo),
    ipHash ? admin.from("reports").select("id", { count: "exact", head: true }).eq("ip_hash", ipHash).gt("created_at", dayAgo) : Promise.resolve({ count: 0 }),
  ]);
  if ((all ?? 0) >= 100 || (mine ?? 0) >= 10 || (fromIp ?? 0) >= 10) return json({ error: "Too many reports right now. Please email " + SUPPORT + "." }, 429);

  const { data: row, error } = await admin.from("reports").upsert({ job_id: post, kind, email, details, ip_hash: ipHash }, { onConflict: "job_id,email", ignoreDuplicates: true })
    .select("id").maybeSingle();
  if (error) { console.error("report insert failed", error.message); return json({ error: "Couldn't send the report. Please email " + SUPPORT + "." }, 500); }
  if (!row) return json({ ok: true }); // already reported by this email

  const key = Deno.env.get("RESEND_API_KEY");
  if (key) { // tell support; the report itself is already saved
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `report-${row.id}` },
      body: JSON.stringify({
        from: "Genjutsu <login@genjutsu-trends.com>", to: [SUPPORT], reply_to: email,
        subject: `Feed report (${kind}) for post ${post.slice(0, 8)}`,
        html: `<p>New <b>${esc(kind)}</b> report for feed post <code>${esc(post)}</code>.</p><p>From: ${esc(email)}</p><p style="white-space:pre-wrap">${esc(details)}</p><p>Review it in the admin dashboard (Reports).</p>`,
      }),
      signal: AbortSignal.timeout(5000),
    }).then((r) => { if (!r.ok) console.error("report email failed", r.status); }).catch((e) => console.error("report email error", e));
  }
  return json({ ok: true });
});
