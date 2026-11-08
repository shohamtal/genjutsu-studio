// POST with header x-report-secret -> deletes uploads older than INPUT_RETENTION_DAYS (default 7).
// Called daily by the scheduled job in the private ops repo. Uploads are kept that long so the
// owner can reproduce a failed render; after that they're gone for good.
import { admin, intEnv, json, safeEqual, serve } from "../_shared/common.ts";

serve(async (req) => {
  const secret = Deno.env.get("REPORT_SECRET") ?? "";
  if (req.method !== "POST" || secret.length < 32 || !safeEqual(req.headers.get("x-report-secret") ?? "", secret)) {
    return json({ error: "unauthorized" }, 401);
  }
  const days = intEnv("INPUT_RETENTION_DAYS", 7);
  if (days === null) return json({ error: "bad INPUT_RETENTION_DAYS" }, 500);
  let deleted = 0;
  for (let round = 0; round < 10; round++) { // at most 10 x 1000 files per run
    const { data: paths, error } = await admin.rpc("expired_inputs", { p_days: days, p_limit: 1000 });
    if (error) { console.error("expired_inputs failed", error); return json({ error: "list failed", deleted }, 500); }
    if (!paths?.length) break;
    const { error: rmErr } = await admin.storage.from("inputs").remove(paths as string[]);
    if (rmErr) { console.error("remove failed", rmErr); return json({ error: "remove failed", deleted }, 500); }
    deleted += paths.length;
  }
  // Feed files of posts that aren't live any more (normally deleted at once; this catches failed or partial copies).
  let feedDeleted = 0;
  const { data: orphans, error: oErr } = await admin.rpc("orphan_feed_files", { p_limit: 1000 });
  if (oErr) console.error("orphan_feed_files failed", oErr.message); // e.g. before migration 016: skip
  else if (orphans?.length) {
    const { error: fErr } = await admin.storage.from("feed").remove(orphans as string[]);
    if (fErr) console.error("feed orphan remove failed", fErr.message); else feedDeleted = orphans.length;
  }
  return json({ deleted, retention_days: days, feed_deleted: feedDeleted });
});
