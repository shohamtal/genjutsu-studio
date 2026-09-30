// POST {job_id} -> {job}   Refreshes one of the caller's jobs from Higgsfield.
import { admin, getUser, json, syncJob, serve } from "../_shared/common.ts";

serve(async (req) => {
  const user = await getUser(req);
  if (!user) return json({ error: "Please sign in first." }, 401);

  const { job_id } = await req.json().catch(() => ({}));
  const { data: job } = await admin.from("jobs").select("*")
    .eq("id", job_id).eq("user_id", user.id).maybeSingle();
  if (!job) return json({ error: "Not found" }, 404);
  return json({ job: await syncJob(job) });
});
