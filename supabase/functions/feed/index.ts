// Public feed (no sign-in). Only published, visible posts; never the owner's id or email.
// GET ?before=<ISO time>  -> {posts, next}   newest first, 24 per page
// GET ?id=<post id>       -> {post}          one post (the Custom page's Recreate prefill)
import { admin, json, serve } from "../_shared/common.ts";
import { isUuid, POST_COLUMNS, type Post } from "../_shared/feed.ts";

const PAGE = 24;
const live = () => admin.from("jobs").select(POST_COLUMNS)
  .not("published_at", "is", null).is("hidden_at", null).is("removed_at", null);
// The prompt is user text: the client renders it with textContent, never as HTML.
const shape = (p: Post) => ({
  id: p.id, published_at: p.published_at, prompt: p.prompt ?? "", workflow: p.workflow, model: p.model === "light" ? "light" : "full",
  resolution: p.resolution, secs: p.billed_secs, video: p.feed_video, source: p.feed_source, images: p.feed_images ?? [],
});

serve(async (req) => {
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  const q = new URL(req.url).searchParams;
  const cache = { "Cache-Control": "public, max-age=30" };
  const out = (body: unknown, status = 200) => { const r = json(body, status); if (status === 200) for (const [k, v] of Object.entries(cache)) r.headers.set(k, v); return r; };
  const id = q.get("id");
  if (id !== null) {
    if (!isUuid(id)) return json({ error: "not found" }, 404);
    const { data } = await live().eq("id", id).maybeSingle();
    return data ? out({ post: shape(data as Post) }) : json({ error: "not found" }, 404);
  }
  let query = live().order("published_at", { ascending: false }).limit(PAGE);
  const before = q.get("before");
  if (before !== null) {
    if (!/^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:?\d\d)$/.test(before) || isNaN(Date.parse(before))) return json({ error: "bad cursor" }, 400);
    query = query.lt("published_at", new Date(before).toISOString());
  }
  const { data, error } = await query;
  if (error) { console.error("feed failed", error.message); return json({ error: "Couldn't load the feed." }, 500); }
  const posts = (data as Post[]).map(shape);
  return out({ posts, next: posts.length === PAGE ? posts[posts.length - 1].published_at : null });
});
