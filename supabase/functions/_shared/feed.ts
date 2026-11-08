// Public feed: published videos live in the public "feed" bucket, one folder per job (feed/<job id>/), so they
// survive the 7-day upload cleanup. Only edge functions (service role) write there.
import { admin, inputPath, PRESETS_PUBLIC } from "./common.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
export const FEED_PUBLIC = `${SB_URL}/storage/v1/object/public/feed/`;
// Files are copied one at a time in memory, so cap them well under the edge function's memory.
const MAX_BYTES = 80 * 1024 * 1024;
const TOO_BIG = "This video is too large to publish (each file must be under 80 MB).";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const isUuid = (s: unknown): s is string => typeof s === "string" && new RegExp(`^${UUID}$`).test(s);

/** Object path inside the feed bucket for one of our feed URLs (exact shape only), or null. */
export function feedPath(url: string): string | null {
  if (!url.startsWith(FEED_PUBLIC)) return null;
  const p = url.slice(FEED_PUBLIC.length);
  return new RegExp(`^${UUID}/(out\\.mp4|source\\.(mp4|mov)|[0-7]\\.(jpe?g|png|webp))$`, "i").test(p) ? p : null;
}

// What a post exposes publicly (never the owner's id or email).
export const POST_COLUMNS = "id, published_at, prompt, workflow, model, resolution, billed_secs, feed_video, feed_source, feed_images";
export type Post = {
  id: string; published_at: string; prompt: string | null; workflow: string; model: string | null; resolution: string;
  billed_secs: number | null; feed_video: string; feed_source: string; feed_images: string[];
};

/** The live post whose feed source is this URL, or null (unpublished, deleted or removed posts don't count). */
export async function liveFeedPost(sourceUrl: string): Promise<Post | null> {
  const path = feedPath(sourceUrl);
  if (!path || !/\/source\.(mp4|mov)$/i.test(path)) return null;
  const { data } = await admin.from("jobs").select(POST_COLUMNS)
    .eq("id", path.split("/")[0]).eq("feed_source", sourceUrl)
    .not("published_at", "is", null).is("hidden_at", null).is("removed_at", null).maybeSingle();
  return (data as Post | null) ?? null;
}

const EXT = /\.([a-z0-9]{2,4})$/i;
const TYPES: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** Read one input of a job: a private upload, a feed file (a Recreate), or (for the output) a provider URL. */
async function readFile(url: string): Promise<Blob> {
  const ip = inputPath(url), fp = feedPath(url);
  if (ip || fp) {
    const bucket = ip ? "inputs" : "feed", path = (ip ?? fp)!;
    const slash = path.lastIndexOf("/");
    const { data: ls } = await admin.storage.from(bucket).list(path.slice(0, slash), { search: path.slice(slash + 1), limit: 5 });
    const meta = ls?.find((f) => f.name === path.slice(slash + 1));
    if (!meta) throw new FeedError("This video's uploads were deleted after 7 days, so it can't be published.");
    if (Number(meta.metadata?.size ?? 0) > MAX_BYTES) throw new FeedError(TOO_BIG);
    const { data, error } = await admin.storage.from(bucket).download(path);
    if (error || !data) throw new FeedError("This video's uploads were deleted after 7 days, so it can't be published.");
    if (data.size > MAX_BYTES) throw new FeedError(TOO_BIG);
    return data;
  }
  if (!/^https:\/\//.test(url)) throw new FeedError("This video can't be published.");
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new FeedError("We couldn't copy the video. Please try again.");
  const len = Number(r.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) { await r.body?.cancel(); throw new FeedError(TOO_BIG); }
  const b = await r.blob();
  if (b.size > MAX_BYTES) throw new FeedError(TOO_BIG);
  return b;
}

export class FeedError extends Error {}

type PublishJob = { id: string; user_id: string; video_url?: string; image_urls?: unknown; output_url?: string | null; remix_of?: string | null };

/**
 * Copy a finished job's output, source video and photos to feed/<job id>/.
 * - Photos: only the owner's own uploads. A Recreate that still uses the original post's photos can't be published,
 *   so someone's face never spreads beyond the post they consented to.
 * - Source: the owner's own upload, or (a Recreate) the source of the post it was made from (remix_of). Such a post
 *   leaves the feed together with the original (unpublish() cascades), so the original owner can always withdraw it.
 * - Never a trend scene (presets/): it's ours, not the user's.
 */
export async function copyToFeed(job: PublishJob): Promise<{ video: string; source: string; images: string[] }> {
  const own = (u: string) => !!inputPath(u)?.startsWith(`${job.user_id}/`);
  const src = String(job.video_url ?? "");
  const fromPost = feedPath(src);
  const remixSource = !!fromPost && isUuid(job.remix_of) && fromPost.startsWith(`${job.remix_of}/source.`);
  if (src.startsWith(PRESETS_PUBLIC) || !(own(src) || remixSource)) {
    throw new FeedError("Only videos made from your own uploaded video can be published.");
  }
  const imgs = (Array.isArray(job.image_urls) ? job.image_urls : []).map(String);
  if (imgs.some((u) => feedPath(u))) throw new FeedError("Replace the original photos with your own to publish this video.");
  if (!imgs.length || imgs.length > 8 || !imgs.every(own)) throw new FeedError("This video can't be published.");
  if (!job.output_url) throw new FeedError("This video isn't ready yet.");
  const ext = (u: string, def: string) => (u.match(EXT)?.[1] ?? def).toLowerCase().replace("jpeg", "jpg");
  const plan: [string, string, string][] = [ // [from, to path, content type]
    [job.output_url, `${job.id}/out.mp4`, "video/mp4"],
    [src, `${job.id}/source.${ext(src, "mp4")}`, TYPES[ext(src, "mp4")] ?? "video/mp4"],
    ...imgs.map((u, i): [string, string, string] => [u, `${job.id}/${i}.${ext(u, "jpg")}`, TYPES[ext(u, "jpg")] ?? "image/jpeg"]),
  ];
  for (const [, to, type] of plan) if (!feedPath(`${FEED_PUBLIC}${to}`) || !type.match(/^(video|image)\//)) throw new FeedError("This video can't be published.");
  for (const [from, to, type] of plan) {
    const blob = await readFile(from);
    // Short cache: after an unpublish or a removal, the CDN must stop serving the file soon.
    const { error } = await admin.storage.from("feed").upload(to, blob, { contentType: type, upsert: true, cacheControl: "60" });
    if (error) { console.error("feed upload failed", job.id, to, error.message); throw new FeedError("We couldn't publish the video. Please try again."); }
  }
  const url = (p: string) => `${FEED_PUBLIC}${p}`;
  return { video: url(plan[0][1]), source: url(plan[1][1]), images: plan.slice(2).map((x) => url(x[1])) };
}

/** Delete a job's feed folder (unpublish, delete, removal after a report). Never throws. */
export async function deleteFeed(jobId: string) {
  if (!isUuid(jobId)) return;
  try {
    const { data } = await admin.storage.from("feed").list(jobId, { limit: 20 });
    const paths = (data ?? []).map((f) => `${jobId}/${f.name}`);
    if (paths.length) {
      const { error } = await admin.storage.from("feed").remove(paths);
      if (error) console.error("feed delete failed", jobId, error.message);
    }
  } catch (e) { console.error("feed delete error", jobId, e); }
}

/**
 * Unpublish a job and delete its feed copies, then do the same for every published Recreate made from it (and their
 * Recreates): they reuse its source video, so they must leave with it.
 */
export async function unpublish(jobId: string, seen = new Set<string>()) {
  if (seen.has(jobId) || seen.size > 200) return;
  seen.add(jobId);
  await admin.from("jobs").update({ published_at: null, feed_video: null, feed_source: null, feed_images: null }).eq("id", jobId);
  await deleteFeed(jobId);
  const { data: kids } = await admin.from("jobs").select("id").eq("remix_of", jobId).not("feed_video", "is", null);
  for (const k of kids ?? []) await unpublish(k.id, seen);
}
