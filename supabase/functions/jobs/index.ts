// POST {job_id} -> {job}                   Refreshes one of the caller's jobs from Higgsfield.
// POST {job_id, action: "hide"} -> {ok}    "Delete" on My videos: hides a finished job for its owner and
//                                          turns its share link off (the row stays for payments/refunds).
// POST {job_id, action: "rate", stars, comment?} -> {ok}   Private 1–5 rating of a finished video (owner only).
// POST {job_id, action: "gallery", opt_in: bool} -> {ok}    Consent to feature this video + prompt in the gallery (old app.js).
// POST {job_id, action: "publish", publish: bool} -> {ok, published_at}   Publish to (or remove from) the public feed:
//                                          the video, its prompt, the source video and the photos (copied to feed/).
import { admin, getUser, json, syncJob, serve, TERMINAL } from "../_shared/common.ts";
import { copyToFeed, FeedError, unpublish } from "../_shared/feed.ts";

serve(async (req) => {
  const user = await getUser(req);
  if (!user) return json({ error: "Please sign in first." }, 401);

  const body = await req.json().catch(() => ({}));
  const { job_id, action } = body;
  const { data: job } = await admin.from("jobs").select("*")
    .eq("id", job_id).eq("user_id", user.id).maybeSingle();
  if (!job) return json({ error: "Not found" }, 404);
  if (action === "hide") {
    if (!TERMINAL.has(job.status) && job.status !== "submit_unknown") {
      return json({ error: "You can delete a video once it has finished." }, 400);
    }
    // Deleting also withdraws gallery consent and unpublishes: a deleted video must never be shown.
    await admin.from("jobs").update({ hidden_at: new Date().toISOString(), share_token: null, gallery_opt_in_at: null }).eq("id", job.id);
    if (job.published_at || job.feed_video) await unpublish(job.id);
    return json({ ok: true });
  }
  if (action === "rate") {
    if (job.status !== "completed") return json({ error: "You can rate a video once it's ready." }, 400);
    const stars = Number(body.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) return json({ error: "Pick 1 to 5 stars." }, 400);
    // No comment sent (a star click) keeps the saved comment; a sent one replaces it. Cut by characters, not
    // UTF-16 units, so an emoji at the limit isn't split.
    const row: Record<string, unknown> = { job_id: job.id, user_id: user.id, stars, updated_at: new Date().toISOString() };
    if (typeof body.comment === "string") row.comment = Array.from(body.comment.trim()).slice(0, 500).join("") || null;
    const { error } = await admin.from("ratings").upsert(row, { onConflict: "job_id" });
    if (error) { console.error("rating failed", job.id, error.message); return json({ error: "Couldn't save your rating." }, 500); }
    return json({ ok: true });
  }
  if (action === "gallery") { // owner's opt-in (or opt-out) to show this video and its prompt in the gallery
    if (job.status !== "completed") return json({ error: "You can share a video once it's ready." }, 400);
    const on = body.opt_in === true, at = on ? new Date().toISOString() : null;
    const { error } = await admin.from("jobs").update({ gallery_opt_in_at: at }).eq("id", job.id);
    if (error) { console.error("gallery opt-in failed", job.id, error.message); return json({ error: "Couldn't save that. Please try again." }, 500); }
    return json({ ok: true, opt_in: on, at });
  }
  if (action === "publish") {
    if (body.publish !== true) { // unpublish: always allowed
      await unpublish(job.id);
      return json({ ok: true, published_at: null });
    }
    if (job.status !== "completed" || job.hidden_at) return json({ error: "You can publish a video once it's ready." }, 400);
    if (job.removed_at) return json({ error: "This video was removed from the feed after a report, so it can't be published again." }, 403);
    if (job.published_at) return json({ ok: true, published_at: job.published_at });
    const { data: p } = await admin.from("profiles").select("publish_banned_at").eq("user_id", user.id).maybeSingle();
    if (p?.publish_banned_at) return json({ error: "Your account can't publish to the feed any more, because 3 of your videos were removed after reports." }, 403);
    try {
      const feed = await copyToFeed(job);
      const at = new Date().toISOString();
      // Re-check after the copy: a 3rd-strike removal (ban) or a removal of the original post may have landed meanwhile.
      const { data: p2 } = await admin.from("profiles").select("publish_banned_at").eq("user_id", user.id).maybeSingle();
      const { data: orig } = job.remix_of ? await admin.from("jobs").select("published_at, removed_at, hidden_at").eq("id", job.remix_of).maybeSingle() : { data: null };
      if (p2?.publish_banned_at || (job.remix_of && (!orig?.published_at || orig.removed_at || orig.hidden_at))) {
        await unpublish(job.id);
        return json({ error: p2?.publish_banned_at ? "Your account can't publish to the feed any more." : "The video you recreated left the feed, so this one can't be published." }, 403);
      }
      // Conditional: a removal (or a delete) that lands while we copy wins.
      const { data: set, error } = await admin.from("jobs")
        .update({ published_at: at, feed_video: feed.video, feed_source: feed.source, feed_images: feed.images })
        .eq("id", job.id).is("removed_at", null).is("hidden_at", null).select("id").maybeSingle();
      if (error || !set) { await unpublish(job.id); return json({ error: "Couldn't publish the video. Please try again." }, 409); }
      if (job.remix_of) { // after our write: if the original left meanwhile, its cascade may have missed us, so leave now
        const { data: o2 } = await admin.from("jobs").select("published_at, removed_at, hidden_at").eq("id", job.remix_of).maybeSingle();
        if (!o2?.published_at || o2.removed_at || o2.hidden_at) {
          await unpublish(job.id);
          return json({ error: "The video you recreated left the feed, so this one can't be published." }, 403);
        }
      }
      return json({ ok: true, published_at: at });
    } catch (e) {
      if (e instanceof FeedError) return json({ error: e.message }, 400);
      console.error("publish failed", job.id, e);
      await unpublish(job.id);
      return json({ error: "Couldn't publish the video. Please try again." }, 500);
    }
  }
  return json({ job: await syncJob(job) });
});
