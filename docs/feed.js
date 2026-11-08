// Home page feed: videos that users published (newest first). A tap opens the video with its prompt,
// "Recreate" (opens the Custom page with the same video, photos and prompt) and "Report".
// Everything from the server is shown with textContent / src only, never as HTML.
(() => {
  const C = window.GENJUTSU_CONFIG;
  const $ = (id) => document.getElementById(id);
  const grid = $("feed-grid"), more = $("feed-more"), section = $("feed");
  if (!grid || !C?.SUPABASE_URL) return;
  const API = `${C.SUPABASE_URL}/functions/v1/`;
  const FEED_BASE = `${C.SUPABASE_URL}/storage/v1/object/public/feed/`;
  const okUrl = (u) => typeof u === "string" && u.startsWith(FEED_BASE) && !u.slice(FEED_BASE.length).includes("..");
  const okId = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s || "");
  let next = null, loading = false, current = null;

  // Cards play muted while on screen, so the feed looks alive without loading every video at once.
  const io = "IntersectionObserver" in window ? new IntersectionObserver((es) => es.forEach((e) => {
    const v = e.target;
    if (e.isIntersecting) { if (!v.src) v.src = v.dataset.src; v.play().catch(() => {}); } else v.pause();
  }), { threshold: 0.5 }) : null;

  function card(p) {
    const a = document.createElement("a");
    a.className = "feed-card"; a.href = `/custom/?from=${p.id}`; // works without JS too: straight to Recreate
    a.innerHTML = `<div class="fc-media"><video muted loop playsinline preload="none"></video></div>
      <div class="fc-body"><span class="fc-prompt"></span><span class="fc-go">Recreate</span></div>`;
    const v = a.querySelector("video"); v.dataset.src = p.video;
    if (io) io.observe(v); else v.src = p.video;
    a.querySelector(".fc-prompt").textContent = p.prompt || "No prompt";
    a.onclick = (e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); open(p); };
    return a;
  }

  async function load() {
    if (loading) return; loading = true; more.disabled = true;
    try {
      const r = await fetch(`${API}feed${next ? `?before=${encodeURIComponent(next)}` : ""}`, { headers: { apikey: C.SUPABASE_ANON_KEY } });
      if (!r.ok) throw new Error();
      const d = await r.json();
      const posts = (d.posts || []).filter((p) => okId(p.id) && okUrl(p.video));
      posts.forEach((p) => grid.appendChild(card(p)));
      next = d.next || null;
      if (grid.children.length) section.hidden = false;
      $("feed-empty") && ($("feed-empty").hidden = grid.children.length > 0);
    } catch { /* feed is optional: the rest of the page works without it */ }
    finally { loading = false; more.disabled = false; more.hidden = !next; }
  }

  // Large view
  const dlg = $("feed-modal");
  function open(p) {
    current = p;
    const v = $("fm-video"); v.src = p.video; v.play().catch(() => {});
    $("fm-prompt").textContent = p.prompt || "No prompt";
    $("fm-meta").textContent = `${p.model === "light" ? "Budget" : "Premium"} · ${p.workflow === "object-swap" ? "object swap" : "motion transfer"} · ${p.resolution}${p.secs ? ` · ${p.secs} s` : ""}`;
    $("fm-recreate").href = `/custom/?from=${p.id}`;
    dlg.showModal();
  }
  dlg?.addEventListener("close", () => { const v = $("fm-video"); v.pause(); v.removeAttribute("src"); v.load(); });

  // Report
  const rep = $("report-modal");
  $("fm-report")?.addEventListener("click", () => {
    $("report-err").textContent = ""; $("report-done").hidden = true; $("report-form").hidden = false;
    rep.showModal();
  });
  $("report-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, btn = f.querySelector("button[type=submit]");
    const kind = f.querySelector("input[name=kind]:checked")?.value;
    if (!current || !kind) return ($("report-err").textContent = "Pick a reason.");
    btn.disabled = true; $("report-err").textContent = "";
    try {
      const r = await fetch(`${API}report`, {
        method: "POST", headers: { apikey: C.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ post: current.id, kind, email: $("report-email").value.trim(), details: $("report-details").value.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Couldn't send the report.");
      f.reset(); f.hidden = true; $("report-done").hidden = false;
    } catch (err) { $("report-err").textContent = err.message; }
    finally { btn.disabled = false; }
  });

  more.addEventListener("click", load);
  load();
})();
