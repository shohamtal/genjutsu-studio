// POST {report_id, outcome: "remove" | "dismiss"} with header x-moderation-secret -> {ok, strikes?}
// Called only by the local admin dashboard (genjutsu-ops). "remove" takes the post off the feed, deletes its feed
// copies, adds a strike to the owner (3 strikes: no more publishing, other posts unpublished) and emails the owner.
// "dismiss" closes every open report on that post; the post stays up.
import { admin, json, safeEqual, serve } from "../_shared/common.ts";
import { deleteFeed, isUuid, unpublish } from "../_shared/feed.ts";

const BAN_AT = 3;

async function mailOwner(userId: string, strikes: number, kind: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return;
  const { data: u } = await admin.auth.admin.getUserById(userId);
  const to = u?.user?.email;
  if (!to) return;
  const banned = strikes >= BAN_AT;
  const why = kind === "copyright" ? "a copyright report" : kind === "consent" ? "a report from someone in it who didn't agree" : "a report";
  const text = `One of your videos was removed from the Genjutsu Trends feed after ${why}. ` +
    (banned ? `This is the ${BAN_AT}rd removal, so your account can no longer publish to the feed. Your other published videos were unpublished. ` : `Removal ${strikes} of ${BAN_AT}: after ${BAN_AT} removals, your account can no longer publish to the feed. `) +
    `The video is still in your account under My videos. If you think this was a mistake, reply to this email.`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "Genjutsu <login@genjutsu-trends.com>", to: [to], reply_to: "support@genjutsu-trends.com",
      subject: "Your video was removed from the feed", text }),
    signal: AbortSignal.timeout(5000),
  }).then((r) => { if (!r.ok) console.error("removal email failed", r.status); }).catch((e) => console.error("removal email error", e));
}

serve(async (req) => {
  const secret = Deno.env.get("MODERATION_SECRET") ?? "";
  if (req.method !== "POST" || secret.length < 32 || !safeEqual(req.headers.get("x-moderation-secret") ?? "", secret)) {
    return json({ error: "unauthorized" }, 401);
  }
  const b = await req.json().catch(() => ({}));
  if (!isUuid(b.report_id) || !["remove", "dismiss"].includes(b.outcome)) return json({ error: "bad request" }, 400);
  const { data: rep } = await admin.from("reports").select("id, job_id, outcome, kind").eq("id", b.report_id).maybeSingle();
  if (!rep) return json({ error: "not found" }, 404);
  if (rep.outcome) return json({ ok: true, already: rep.outcome });

  if (b.outcome === "dismiss") {
    await admin.from("reports").update({ outcome: "dismissed", resolved_at: new Date().toISOString() }).eq("job_id", rep.job_id).is("outcome", null);
    return json({ ok: true });
  }

  const { data: strikes, error } = await admin.rpc("remove_reported", { p_report: rep.id, p_ban_at: BAN_AT });
  if (error) { console.error("remove_reported failed", error.message); return json({ error: "remove failed" }, 500); }
  await deleteFeed(rep.job_id);
  await admin.from("jobs").update({ feed_video: null, feed_source: null, feed_images: null }).eq("id", rep.job_id);
  // Published Recreates reuse this post's source video: they leave the feed too (no strike for their owners).
  const { data: kids } = await admin.from("jobs").select("id").eq("remix_of", rep.job_id).not("feed_video", "is", null);
  for (const k of kids ?? []) await unpublish(k.id);
  const { data: job } = await admin.from("jobs").select("user_id").eq("id", rep.job_id).single();
  if (job && typeof strikes === "number") {
    if (strikes >= BAN_AT) { // the RPC unpublished the rest; delete their public copies too
      const { data: rest } = await admin.from("jobs").select("id").eq("user_id", job.user_id).not("feed_video", "is", null);
      for (const r of rest ?? []) await unpublish(r.id);
    }
    await mailOwner(job.user_id, strikes, rep.kind);
  }
  return json({ ok: true, strikes });
});
