import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const C = window.GENJUTSU_CONFIG;
const DEMO = !C.SUPABASE_URL || !C.SUPABASE_ANON_KEY;
const sb = DEMO ? null : createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
const TERMINAL = new Set(["completed", "failed", "nsfw", "canceled"]);
const $ = (id) => document.getElementById(id);

const state = {
  mode: "motion-transfer", res: "720p",
  video: null, duration: 0, images: [],
  user: null, credits: 0, jobs: [], pendingGenerate: false, pack: C.PACKS[1].id,
};

// ---------------- helpers ----------------
function toast(msg, ms = 3500) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function estimate() {
  if (!state.duration) return 0;
  const secs = Math.min(30, Math.max(4, Math.ceil(state.duration)));
  return Math.ceil(secs * C.CREDITS_PER_SEC[state.res]);
}
async function callFn(name, body) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); msg = j.error || msg; } catch {}
    const e = new Error(msg); e.status = error.context?.status; throw e;
  }
  return data;
}
const demoStore = {
  get() { try { return JSON.parse(localStorage.getItem("gj-demo") || "null") || { credits: 0, jobs: [], email: null }; } catch { return { credits: 0, jobs: [], email: null }; } },
  set(v) { try { localStorage.setItem("gj-demo", JSON.stringify(v)); } catch {} },
};

// ---------------- auth ----------------
async function initAuth() {
  if (DEMO) {
    $("demo-banner").hidden = false;
    const d = demoStore.get();
    if (d.email) setUser({ id: "demo", email: d.email });
    return;
  }
  const { data } = await sb.auth.getSession();
  if (data.session) setUser(data.session.user);
  sb.auth.onAuthStateChange((_e, session) => {
    if (session?.user && session.user.id !== state.user?.id) setUser(session.user);
    if (!session) setUser(null);
  });
}
async function setUser(user) {
  state.user = user;
  $("signin-btn").hidden = !!user;
  $("signout-btn").hidden = !user;
  $("credits-pill").hidden = !user;
  if (!user) { state.jobs = []; renderJobs(); return; }
  $("signin-modal").open && $("signin-modal").close();
  await Promise.all([loadCredits(), loadJobs()]);
  if (state.pendingGenerate) { state.pendingGenerate = false; generate(); }
}
async function loadCredits() {
  if (DEMO) state.credits = demoStore.get().credits;
  else {
    const { data } = await sb.from("profiles").select("credits").eq("user_id", state.user.id).maybeSingle();
    state.credits = data?.credits ?? 0;
  }
  $("credits-val").textContent = state.credits.toLocaleString();
  refresh();
}

$("signin-btn").onclick = () => openSignin();
$("signout-btn").onclick = async () => {
  if (DEMO) { const d = demoStore.get(); d.email = null; demoStore.set(d); setUser(null); }
  else await sb.auth.signOut();
};
function openSignin() {
  $("signin-step1").hidden = false; $("signin-step2").hidden = true; $("signin-err").textContent = "";
  $("signin-modal").showModal(); $("email").focus();
}
$("send-link").onclick = async () => {
  const email = $("email").value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return ($("signin-err").textContent = "Enter a valid email.");
  $("send-link").disabled = true;
  try {
    if (DEMO) {
      const d = demoStore.get(); d.email = email; demoStore.set(d);
      return setUser({ id: "demo", email });
    }
    const { error } = await sb.auth.signInWithOtp({
      email, options: { emailRedirectTo: location.origin + location.pathname },
    });
    if (error) throw error;
    $("sent-to").textContent = email;
    $("signin-step1").hidden = true; $("signin-step2").hidden = false;
  } catch (e) { $("signin-err").textContent = e.message; }
  finally { $("send-link").disabled = false; }
};

// ---------------- inputs ----------------
document.querySelectorAll(".mode").forEach((b) => (b.onclick = () => {
  document.querySelectorAll(".mode").forEach((x) => x.classList.toggle("active", x === b));
  state.mode = b.dataset.mode; refresh();
}));
document.querySelectorAll("#res-seg button").forEach((b) => (b.onclick = () => {
  document.querySelectorAll("#res-seg button").forEach((x) => x.classList.toggle("active", x === b));
  state.res = b.dataset.res; refresh();
}));

function setVideo(file) {
  if (!file) return;
  if (file.type !== "video/mp4") return toast("Please use an MP4 video.");
  const v = $("video-preview");
  v.src = URL.createObjectURL(file);
  v.onloadedmetadata = () => {
    if (v.duration < 4) { toast("The video must be at least 4 seconds."); return clearVideo(); }
    if (v.duration > 30) toast("Only the first 30 seconds will be used.");
    state.video = file; state.duration = v.duration;
    v.hidden = false; v.play().catch(() => {});
    $("video-drop").querySelector(".drop-empty").hidden = true; $("video-clear").hidden = false;
    refresh();
  };
}
function clearVideo() {
  state.video = null; state.duration = 0;
  const v = $("video-preview"); v.hidden = true; v.removeAttribute("src");
  $("video-drop").querySelector(".drop-empty").hidden = false; $("video-clear").hidden = true;
  $("video-input").value = ""; refresh();
}
$("video-input").onchange = (e) => setVideo(e.target.files[0]);
$("video-clear").onclick = (e) => { e.preventDefault(); clearVideo(); };

function addImages(files) {
  for (const f of files) {
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { toast("Use JPG, PNG or WEBP images."); continue; }
    if (state.images.length >= 8) { toast("Up to 8 photos."); break; }
    state.images.push(f);
  }
  renderThumbs(); refresh();
}
function renderThumbs() {
  const box = $("thumbs"); box.innerHTML = "";
  const has = state.images.length > 0;
  box.hidden = !has; $("image-empty").hidden = has;
  state.images.forEach((f, i) => {
    const d = document.createElement("div"); d.className = "thumb";
    d.innerHTML = `<img alt="" /><button class="x" aria-label="Remove">×</button>`;
    d.querySelector("img").src = URL.createObjectURL(f);
    d.querySelector("button").onclick = (e) => { e.stopPropagation(); state.images.splice(i, 1); renderThumbs(); refresh(); };
    box.appendChild(d);
  });
  if (has && state.images.length < 8) {
    const a = document.createElement("button"); a.className = "thumb add"; a.textContent = "+";
    a.onclick = (e) => { e.stopPropagation(); $("image-input").click(); };
    box.appendChild(a);
  }
}
$("image-drop").onclick = (e) => { if (!state.images.length) $("image-input").click(); };
$("image-input").onchange = (e) => { addImages([...e.target.files]); e.target.value = ""; };

for (const [zone, handler] of [["video-drop", (fs) => setVideo(fs[0])], ["image-drop", (fs) => addImages(fs)]]) {
  const z = $(zone);
  z.addEventListener("dragover", (e) => { e.preventDefault(); z.classList.add("over"); });
  z.addEventListener("dragleave", () => z.classList.remove("over"));
  z.addEventListener("drop", (e) => { e.preventDefault(); z.classList.remove("over"); handler([...e.dataTransfer.files]); });
}

function refresh() {
  const cost = estimate();
  $("cost").innerHTML = cost
    ? `≈ <b>${cost.toLocaleString()} credits</b> <span>($${(cost / 100).toFixed(2)}) · ${Math.min(30, Math.ceil(state.duration))}s</span>`
    : "Add a video to see the price";
  const ready = state.video && state.images.length;
  const btn = $("generate-btn");
  btn.disabled = !ready;
  btn.textContent = !ready ? (state.video ? "Add a reference photo" : "Upload a video to start")
    : !state.user ? "Sign in & generate" : state.credits < cost ? "Buy credits & generate" : `Generate · ${cost.toLocaleString()} credits`;
}

// ---------------- generate ----------------
$("generate-btn").onclick = () => generate();
async function upload(file) {
  const ext = (file.name.split(".").pop() || "bin").toLowerCase();
  const path = `${state.user.id}/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from("inputs").upload(path, file, { contentType: file.type });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return sb.storage.from("inputs").getPublicUrl(path).data.publicUrl;
}
async function generate() {
  if (!state.video || !state.images.length) return;
  if (!state.user) { state.pendingGenerate = true; return openSignin(); }
  const cost = estimate();
  if (state.credits < cost) { state.pendingGenerate = true; return openBuy(`This video costs about ${cost.toLocaleString()} credits. You have ${state.credits.toLocaleString()}.`); }

  const btn = $("generate-btn"); btn.disabled = true; btn.textContent = "Uploading…";
  try {
    let job;
    if (DEMO) {
      const d = demoStore.get();
      d.credits -= cost;
      job = { id: crypto.randomUUID(), workflow: state.mode, resolution: state.res, cost, status: "queued",
        created_at: new Date().toISOString(), output_url: null, demo_done_at: Date.now() + 15000 };
      d.jobs.unshift(job); demoStore.set(d);
    } else {
      const [video_url, ...image_urls] = await Promise.all([upload(state.video), ...state.images.map(upload)]);
      btn.textContent = "Starting…";
      ({ job } = await callFn("generate", {
        workflow: state.mode, resolution: state.res, prompt: $("prompt").value.trim(),
        video_url, image_urls, duration: state.duration,
      }));
    }
    state.jobs.unshift(job); renderJobs(); await loadCredits();
    toast("Generating! You can leave this page — your video will be waiting here.");
    $("history").scrollIntoView({ behavior: "smooth" });
    poll();
  } catch (e) {
    if (e.status === 402) { await loadCredits(); openBuy(e.message); } else toast(e.message, 6000);
  } finally { refresh(); }
}

// ---------------- jobs ----------------
async function loadJobs() {
  if (DEMO) state.jobs = demoStore.get().jobs;
  else {
    const { data } = await sb.from("jobs").select("*").order("created_at", { ascending: false }).limit(50);
    state.jobs = data || [];
  }
  renderJobs(); poll();
}
let pollTimer = null;
function poll() {
  clearTimeout(pollTimer);
  const open = state.jobs.filter((j) => !TERMINAL.has(j.status));
  if (!open.length) return;
  pollTimer = setTimeout(async () => {
    let changed = false;
    for (const j of open) {
      let next = j;
      if (DEMO) {
        if (Date.now() > j.demo_done_at) next = { ...j, status: "completed", output_url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" };
        else next = { ...j, status: "in_progress" };
        const d = demoStore.get(); d.jobs = d.jobs.map((x) => (x.id === j.id ? next : x)); demoStore.set(d);
      } else {
        try { next = (await callFn("jobs", { job_id: j.id })).job; } catch {}
      }
      if (next.status !== j.status) changed = true;
      Object.assign(j, next);
    }
    renderJobs();
    if (changed) loadCredits(); // refunds
    poll();
  }, 5000);
}
const LABEL = { submitting: "Starting", queued: "In queue", in_progress: "Rendering", completed: "Ready",
  failed: "Failed · refunded", nsfw: "Blocked · refunded", canceled: "Canceled · refunded" };
function renderJobs() {
  $("history").hidden = !state.jobs.length;
  const box = $("jobs"); box.innerHTML = "";
  for (const j of state.jobs) {
    const el = document.createElement("div"); el.className = "job";
    const when = new Date(j.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    const mode = j.workflow === "object-swap" ? "Object swap" : "Motion transfer";
    el.innerHTML = `
      <div class="job-head"><span class="job-meta">${mode} · ${j.resolution} · ${when}</span>
        <span class="status ${j.status}">${LABEL[j.status] || j.status}</span></div>`;
    if (j.status === "completed" && j.output_url) {
      el.insertAdjacentHTML("beforeend", `<video controls playsinline preload="metadata"></video>
        <div class="job-actions"><a class="btn" target="_blank" rel="noopener" download>Download</a></div>`);
      el.querySelector("video").src = j.output_url;
      el.querySelector("a").href = j.output_url;
    } else if (!TERMINAL.has(j.status)) {
      el.insertAdjacentHTML("beforeend", `<div class="progress"><i></i></div><div class="job-meta">Usually takes a few minutes. Safe to refresh or close.</div>`);
    } else if (j.error) {
      const p = document.createElement("p"); p.className = "err"; p.textContent = j.error; el.appendChild(p);
    }
    box.appendChild(el);
  }
}

// ---------------- buy credits ----------------
$("credits-pill").onclick = () => openBuy();
function openBuy(reason) {
  $("buy-reason").textContent = reason || "One-time payment. No subscription.";
  $("buy-err").textContent = "";
  renderPacks(); $("buy-modal").showModal(); renderPayPal();
}
$("buy-modal").addEventListener("close", () => { state.pendingGenerate = false; });
function renderPacks() {
  const box = $("packs"); box.innerHTML = "";
  for (const p of C.PACKS) {
    const b = document.createElement("button");
    b.className = "pack" + (p.id === state.pack ? " active" : "");
    b.innerHTML = `<span><span class="p-name">${p.label}</span>${p.tag ? `<span class="tag">${p.tag}</span>` : ""}
      <div class="p-cred">${p.credits.toLocaleString()} credits</div></span><span class="p-price">$${p.usd}</span>`;
    b.onclick = () => { state.pack = p.id; renderPacks(); renderPayPal(); };
    box.appendChild(b);
  }
}
async function onPaid(creditsAdded) {
  await loadCredits();
  const resume = state.pendingGenerate;
  $("buy-modal").close();
  toast(`+${creditsAdded.toLocaleString()} credits added. Thank you!`);
  refresh();
  if (resume) generate();
}
let ppLoaded = null;
function loadPayPal() {
  return (ppLoaded ||= new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(C.PAYPAL_CLIENT_ID)}&currency=USD&intent=capture&components=buttons`;
    s.onload = res; s.onerror = () => rej(new Error("Could not load PayPal."));
    document.head.appendChild(s);
  }));
}
async function renderPayPal() {
  const box = $("paypal-buttons"); box.innerHTML = "";
  const pack = C.PACKS.find((p) => p.id === state.pack);
  if (DEMO || !C.PAYPAL_CLIENT_ID) {
    const b = document.createElement("button"); b.className = "btn primary wide";
    b.textContent = `Pay $${pack.usd} (demo)`;
    b.onclick = () => { const d = demoStore.get(); d.credits += pack.credits; demoStore.set(d); onPaid(pack.credits); };
    return box.appendChild(b);
  }
  try {
    await loadPayPal();
    await window.paypal.Buttons({
      style: { layout: "vertical", shape: "rect", label: "pay" },
      createOrder: async () => (await callFn("paypal", { action: "create", pack_id: pack.id })).order_id,
      onApprove: async ({ orderID }) => {
        const r = await callFn("paypal", { action: "capture", order_id: orderID });
        onPaid(r.credits_added);
      },
      onError: (err) => { $("buy-err").textContent = err?.message || "Payment failed. You were not charged."; },
    }).render(box);
  } catch (e) { $("buy-err").textContent = e.message; }
}

// ---------------- boot ----------------
refresh();
initAuth();
