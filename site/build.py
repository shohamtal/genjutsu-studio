#!/usr/bin/env python3
"""Generate the static site in docs/ from site/trends.json.

Add a trend: upload its clip + poster to Supabase storage in the public "presets" bucket,
add an entry to trends.json, drop a 1200x630 og.jpg in docs/trends/<slug>/
(optional, falls back to the poster), then run:  python3 site/build.py
"""
import hashlib
import html
import re
import json
import math
import subprocess
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
DOCS = ROOT / "docs"
DATA = json.loads((SITE / "trends.json").read_text())
BASE = DATA["base_url"]
ALL_TRENDS = DATA["trends"]
# hidden trends (e.g. the 4s QA clip) get a page but stay out of the gallery, links and sitemap
# Retired slugs keep a name, so old videos made on them don't show up as "Custom".
TREND_ALIASES = {"hotel-lobby-v2": "hotel-lobby", "desert-truck-jump": "car-jump"}


def trend_names():
    names = {t["slug"]: t["short"] for t in ALL_TRENDS}
    names.update({old: names[new] for old, new in TREND_ALIASES.items() if new in names})
    return names


# Newest first (by "published"); trends published the same day keep their order in trends.json.
# Gallery order: 60% popularity (paid videos in the last 30 days, site/popularity.py, log-scaled so one hit
# can't bury the rest) + 40% newness (halves every 10 days after `published`). New-and-selling on top,
# old-and-unbought at the bottom.
_POP = json.loads((SITE / "popularity.json").read_text()) if (SITE / "popularity.json").exists() else {}
for _old, _new in TREND_ALIASES.items():
    _POP[_new] = _POP.get(_new, 0) + _POP.pop(_old, 0)
_POP_MAX = max([1] + list(_POP.values()))


def trend_score(t):
    pop = math.log1p(_POP.get(t["slug"], 0)) / math.log1p(_POP_MAX)
    try:
        age = max(0, (date.today() - date.fromisoformat(t.get("published", "2026-01-01"))).days)
    except ValueError:
        age = 365
    return 0.6 * pop + 0.4 * 0.5 ** (age / 10)


assert all(re.fullmatch(r"[a-z0-9-]{1,40}", t["slug"]) for t in ALL_TRENDS), "bad slug in trends.json"
TRENDS = sorted((t for t in ALL_TRENDS if not t.get("hidden")), key=lambda t: (trend_score(t), t.get("published", "")), reverse=True)
TODAY = date.today().isoformat()
CREDITS_PER_SEC_DEFAULT = 47.7  # 480p; keep in sync with docs/config.js
FEE_CREDITS = 100
RATES = {"480p": 47.7, "720p": 102.15, "1080p": 244.8}  # credits/sec, keep in sync with docs/config.js
LIGHT_RATES = {"480p": 15, "720p": 30, "1080p": 60}  # Budget mode (Genjutsu Light), output + source billed; keep in sync
# Changes whenever app.js / styles.css / config.js change, so browsers never run a stale copy.
# Every file loaded with ?v=ASSET_VER must be in this list: Cloudflare tells browsers to keep ?v= files for a year.
ASSET_VER = __import__("hashlib").sha1(b"".join((DOCS / f).read_bytes() for f in ("app.js", "styles.css", "config.js", "watch.js", "goatcounter.js", "vendor-supabase.js"))).hexdigest()[:10]

esc = html.escape


def abs_url(p):
    """Site-relative asset path (or full URL) -> absolute URL, for meta tags / JSON-LD."""
    return p if p.startswith("http") else BASE + p


def rel(root, p):
    """Site-relative asset path (or full URL) -> URL relative to the current page."""
    return p if p.startswith("http") else root + p


def css_url(p):
    """A path for a CSS url("..."): only plain URL characters, so it can't end the string or the style attribute."""
    if not re.fullmatch(r"[A-Za-z0-9._~/:%-]+", p):
        raise ValueError(f"unsafe CSS url: {p!r}")
    return p


def ld(*objs):
    # <, > and & as \u escapes: no value can close the script tag early; still valid JSON-LD.
    js = lambda o: json.dumps(o, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return "\n".join(f'  <script type="application/ld+json">{js(o)}</script>' for o in objs if o)


def breadcrumbs(*items):
    return {
        "@context": "https://schema.org", "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": i + 1, "name": n, "item": BASE + p} for i, (n, p) in enumerate(items)
        ],
    }


def faq_ld(faq):
    return {
        "@context": "https://schema.org", "@type": "FAQPage",
        "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faq],
    }


def faq_html(faq):
    return "\n".join(f"      <details><summary>{esc(q)}</summary><p>{esc(a)}</p></details>" for q, a in faq)


def og_image(path, trend=None):
    if trend and (DOCS / "trends" / trend["slug"] / "og.jpg").exists():
        return f"{BASE}trends/{trend['slug']}/og.jpg"
    if trend:
        return abs_url(trend["poster"])
    return f"{BASE}og.jpg"


def head(*, path, title, description, og_title=None, og_type="website", image, extra_ld="", noindex=False):
    root = "../" * path.count("/")
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{esc(title)}</title>
  <meta name="description" content="{esc(description)}" />{'\n  <meta name="robots" content="noindex,nofollow" />' if noindex else ''}
  <link rel="canonical" href="{BASE}{path}" />
{'' if noindex else '  <meta name="robots" content="index,follow,max-image-preview:large" />'}
  <meta property="og:type" content="{og_type}" />
  <meta property="og:site_name" content="Genjutsu Studio" />
  <meta property="og:title" content="{esc(og_title or title)}" />
  <meta property="og:description" content="{esc(description)}" />
  <meta property="og:url" content="{BASE}{path}" />
  <meta property="og:image" content="{image}" />
  <meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="{esc(og_title or title)}" />
  <meta name="twitter:description" content="{esc(description)}" />
  <meta name="twitter:image" content="{image}" />
  <meta name="theme-color" content="#0b0b10" />
  <link rel="icon" href="/favicon.ico" sizes="48x48" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="preload" href="/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="stylesheet" href="{root}styles.css?v={ASSET_VER}" />
  <script data-goatcounter="https://genjutsu-trends.goatcounter.com/count" async src="{root}goatcounter.js?v={ASSET_VER}"></script>
{extra_ld}
</head>
<body>
  <div class="banner notice" role="status">💜 Dear customers: we're working with our service providers to bring you better prices over the next few days. Stay tuned, more discounts are coming!</div>
  <div id="demo-banner" class="banner" hidden>Demo mode: the backend isn't connected yet, so payments and generation are simulated.</div>
"""


def header(root, app=True, active=""):
    actions = (
        """      <button id="credits-pill" class="pill" hidden><span id="credits-val">0</span> credits <span class="plus">+</span></button>
      <button id="signin-btn" class="btn ghost">Sign in</button>
      <button id="signout-btn" class="btn ghost" hidden>Sign out</button>"""
        if app else f'      <a class="btn primary" href="{root}" style="text-decoration:none">Browse trends</a>'
    )
    cls = lambda k: ' class="active"' if k == active else ""
    return f"""  <header class="top">
    <a class="brand" href="{root}"><span class="logo">🌀</span> Genjutsu<span class="dim">Studio</span></a>
    <nav class="nav"><a href="{root}"{cls('trends')}>Trends</a><a href="{root}custom/"{cls('custom')}>Custom</a><a href="{root}pricing/"{cls('pricing')}>Pricing</a><a href="{root}my-videos/"{cls('videos')}>My videos</a></nav>
    <div class="top-actions">
{actions}
    </div>
  </header>
"""


def footer(root, app=True, page=None):
    trend_links = " · ".join(f'<a href="{root}trends/{t["slug"]}/">{esc(t["short"])}</a>' for t in TRENDS)
    out = f"""  <footer>
    <nav class="foot-links"><a href="{root}">All trends</a> · <!--rank-->{trend_links}<!--/rank--> · <a href="{root}custom/">Custom trend</a> · <a href="{root}pricing/">Pricing</a> · <a href="{root}genjutsu/">About Genjutsu</a> · <a href="{root}terms/">Terms</a> · <a href="{root}privacy/">Privacy</a> · <a href="{root}accessibility/">Accessibility</a></nav>
    Independent service, not affiliated with or endorsed by Higgsfield AI. Videos are made with Higgsfield's Genjutsu model through its API. Not affiliated with the owners of the films and clips referenced, and not affiliated with or endorsed by the artists or their estates.
  </footer>
"""
    if not app:
        return out + "</body>\n</html>\n"
    names = trend_names()
    return out + f"""
  <dialog id="signin-modal" class="modal">
    <form method="dialog" class="modal-x"><button aria-label="Close">×</button></form>
    <h3>Sign in</h3>
    <p class="muted">We'll email you a 6-digit sign-in code. Your credits and videos are saved to your email.</p>
    <div id="signin-step1">
      <label class="field-label" for="email">Email</label>
      <input id="email" type="email" placeholder="you@example.com" autocomplete="email" />
      <button id="send-link" class="btn primary wide">Email me a sign-in code</button>
    </div>
    <div id="signin-step2" hidden>
      <div id="step2-link">
        <p>We sent a sign-in link to <b id="sent-to"></b>. Open it in this browser and you'll come right back here. Photos you added are saved.</p>
      </div>
      <div id="step2-code" hidden>
        <p>We sent a 6-digit code to <b id="sent-to-code"></b>. You can also tap the link in the email.</p>
        <label class="field-label" for="otp">Code from the email</label>
        <input id="otp" class="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="123456" />
        <button id="verify-code" class="btn primary wide">Sign in</button>
      </div>
      <p class="muted">Can't find it? Check your spam folder.</p>
    </div>
    <p class="err" id="signin-err"></p>
  </dialog>

  <dialog id="buy-modal" class="modal">
    <form method="dialog" class="modal-x"><button aria-label="Close">×</button></form>
    <h3>Buy credits</h3>
    <p class="muted" id="buy-reason">One-time payment. No subscription.</p>
    <div class="packs" id="packs"></div>
    <div id="paypal-buttons"></div>
    <p class="err" id="buy-err"></p>
  </dialog>

  <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>

  <script>window.PAGE = {json.dumps(page, ensure_ascii=False)}; window.TREND_NAMES = {json.dumps(names, ensure_ascii=False)};</script>
  <script src="{root}config.js?v={ASSET_VER}"></script>
  <script src="{root}vendor-supabase.js?v={ASSET_VER}"></script>
  <script type="module" src="{root}app.js?v={ASSET_VER}"></script>
</body>
</html>
"""


HISTORY = """    <section id="history">
      <p class="muted" id="mv-signed-out" hidden>Sign in with the email you used to see your videos.
        <button id="mv-signin" class="btn primary">Sign in</button></p>
      <p class="muted" id="mv-empty" hidden>No videos yet. <a href="../">Pick a trend</a> to make your first one.</p>
      <div id="jobs" class="jobs"></div>
    </section>
"""
# Shown under the Generate button once a video has started (studio pages).
STARTED_NOTE = """      <p class="started-note" id="started-note" hidden>✅ Your video is being made. Follow it, watch it and download it in
        <a href="/my-videos/">My videos</a>. You can close this page.</p>
"""

RES_ROW = """      <div class="row">
        <div class="seg" id="res-seg">
          <button data-res="480p" class="active">480p</button>
          <button data-res="720p">720p</button>
          <button data-res="1080p">1080p</button>
        </div>
        <div class="cost" id="cost">Add a video to see the price</div>
      </div>

      <div class="breakdown" id="breakdown" hidden></div>

      <button id="generate-btn" class="btn primary big" disabled>Generate video</button>
      <p class="fine">Failed or moderated generations are refunded automatically. Download your video to keep a copy.</p>
"""


def photos_text(t):
    n, m = len(t["slots"]), t.get("min_photos", len(t["slots"]))
    return f"{m}–{n} photos" if m < n else f"{n} photo{'s' if n > 1 else ''}"


def has_light(t):
    return bool(t.get("light_video_url"))


# ---- shared trend-page sections (one template for every trend) ----
def trend_kind(t):
    if "pet" in t["slug"] or any("pet" in sl["label"].lower() for sl in t["slots"]): return "pet"
    if t["slug"].endswith("baby") and t["slug"] != "industry-baby": return "baby"
    return "group" if len(t["slots"]) > 1 else "solo"


def billed_secs(d, light):
    return min(15 if light else 30, max(4, math.ceil(d - 0.001)))


def credits_for(secs, rate):
    return math.ceil(secs * rate - 1e-9) + FEE_CREDITS


def price_section(t):
    rows = []
    if has_light(t):
        ls = billed_secs(t["light_duration"], True)
        rows.append(("Budget (Genjutsu Light)", f"{ls} s", [credits_for(ls, LIGHT_RATES[r]) for r in RATES]))
    fs = billed_secs(t["duration"], False)
    rows.append(("Premium (full Genjutsu)", f"{fs} s", [credits_for(fs, RATES[r]) for r in RATES]))
    head = "".join(f"<th>{r}</th>" for r in RATES)
    body = "".join(f"<tr><td>{esc(n)} · {d}</td>" + "".join(f"<td><b>${c / 100:.2f}</b><br><span class=\"muted\">{c:,} cr</span></td>" for c in cs) + "</tr>" for n, d, cs in rows)
    low = min(min(cs) for _, _, cs in rows)
    return f"""      <h2>What it costs</h2>
      <p>One {esc(t['short'] if t['short'].lower().endswith('video') else t['short'] + ' video')} costs from <b>${low / 100:.2f}</b>. You pay once for the video you make: no subscription, no monthly plan, and credits never expire (100 credits = $1).</p>
      <div class="price-table"><table><tr><th></th>{head}</tr>{body}</table></div>
      <p>cr = credits. The exact price shows before you click Generate. If a render fails or is blocked by moderation, the credits go back to your account automatically.</p>
"""


def photo_tips(t):
    k = trend_kind(t)
    if k == "pet":
        tips = ["One pet per photo, filling most of the frame", "Its face and body clearly visible, not cut off", "Good, even light (daylight by a window works well)", "No heavy filters, stickers or text on the photo"]
    else:
        tips = ["One person per photo, facing the camera", "Face and upper body in frame, not too far away", "Good, even light: daylight by a window works well", "No sunglasses, masks, heavy filters or group shots"]
        if k == "baby":
            tips.insert(0, "Use a photo of yourself as an adult: the AI makes the toddler for you. Don't upload photos of real children")
        if k == "group":
            n, m = len(t["slots"]), t.get("min_photos", len(t["slots"]))
            tips.append(f"One photo per part ({n} parts), in the order shown on the page" if m >= n
                        else f"Only the first photo is required; add up to {n - 1} more for the other parts, in the order shown" if m == 1
                        else f"The first {m} photos are required; add up to {n - m} more, in the order shown")
        tips.append("Only use photos of people who agreed to be in the video")
    return "      <h2>Photo tips</h2>\n      <ul>\n" + "\n".join(f"        <li>{esc(x)}.</li>" for x in tips) + "\n      </ul>\n"


def extra_faq(t):
    q = [("Do I need to download an app?", "No. Everything runs in your browser, on a phone or a computer. Sign in with your email (we send a 6-digit code) and you're ready."),
         ("How long does it take?", "Usually a few minutes. You can close the tab: the video keeps rendering, it appears under \"My videos\" and we email you when it's ready.")]
    if has_light(t):
        q.append(("What's the difference between Budget mode (Genjutsu Light) and Premium mode?",
                  "Budget uses the Genjutsu Light model: fast, much cheaper, and it renders up to 15 seconds of the scene. Premium uses the full Genjutsu model: it renders the full scene with more detail, and takes a bit longer."))
    q += [("Which resolution should I pick?", "480p is the default and looks fine on TikTok, Reels and Shorts. 720p and 1080p are sharper and cost more; the price updates as you switch."),
          ("What if the video doesn't come out well?", "If the render fails or is blocked by the automatic content check, your credits are refunded automatically. A finished video can't be refunded, because the render has already been paid for, so use a clear, well-lit photo for the best result."),
          ("Can I download and share it?", "Yes. Download the MP4 from \"My videos\" and post it anywhere, or share a link to it.")]
    return q


def prompt_block(t):
    if not has_light(t):  # classic small prompt box (pilot: only Light-enabled trends get the prominent one)
        return f"""      <div class="field prompt-field">
        <div class="prompt-head"><label for="prompt">Prompt</label>
          <button type="button" class="link-btn" id="prompt-edit">✏️ Edit prompt</button>
          <button type="button" class="link-btn" id="prompt-reset" hidden>Reset to default</button></div>
        <textarea id="prompt" rows="3" maxlength="2000" readonly>{esc(t['prompt'])}</textarea>
      </div>
"""
    return f"""      <div class="field prompt-field prominent">
        <div class="prompt-head"><label for="prompt">✍️ Prompt: what Genjutsu will do</label></div>
        <p class="prompt-hint">This is the instruction sent with your photos. Edit it to change clothes, style or details.</p>
        <textarea id="prompt" rows="4" maxlength="2000" readonly>{esc(t['prompt'])}</textarea>
        <div class="prompt-actions">
          <button type="button" class="btn" id="prompt-edit">✏️ Edit prompt</button>
          <button type="button" class="btn ghost" id="prompt-reset" hidden>↺ Reset to default</button>
        </div>
      </div>
"""


def model_row(t):
    if not has_light(t):
        return ""
    return """      <div class="model-row">
        <div class="seg" id="model-seg" role="group" aria-label="Model">
          <button data-model="light" class="active">Budget</button>
          <button data-model="full">Premium</button>
        </div>
        <p class="model-note" id="model-note">Budget mode is fast and cheap and uses 15 seconds of the scene.</p>
      </div>
"""


def model_switch(t):
    long = t["duration"] > 15.001  # Light is shorter than the scene only then
    light_note = "Budget · fast and cheap · uses 15 seconds of the scene. For the full scene, choose Premium." if long else "Budget · fast and cheap."
    if not has_light(t):
        return """        <div class="c-row"><b>Model</b><span class="tag-strong">Premium</span></div>
        <p class="c-note">This scene is longer than Budget mode's 15-second limit, so it uses Premium mode only.</p>
"""
    return """        <div class="c-row">
          <b>Model</b>
          <button type="button" class="switch" id="model-switch" role="switch" aria-checked="false" aria-label="Premium">
            <span class="lbl on" data-m="light">Budget</span><span class="track"><span class="ball"></span></span><span class="lbl" data-m="full">Premium</span>
          </button>
        </div>
        <p class="c-note" id="model-note">{light_note}</p>
""".replace("{light_note}", light_note)


def short_chip(t):
    """Chip on trends longer than Light's 15 s: app.js shows it only while the Budget model is selected."""
    if not t.get("light_preview_url"):
        return ""
    return '          <span class="short-chip" id="short-chip" hidden>⏱ Shorter version · 15 s</span>'


def studio_trend_c(t, root):
    """Design C: video on the left, one control panel on the right (stacks on phones)."""
    return f"""    <section class="studio studio-c" id="studio">
      <div class="c-media">
        <div class="drop locked" id="video-drop" style="width: 100%; aspect-ratio: {video_aspect(t)}; max-height: 324px; background: #000 url(&quot;{css_url(rel(root, t['poster']))}&quot;) center / contain no-repeat">
          <video id="video-preview" muted loop playsinline autoplay controls controlslist="nodownload noplaybackrate" hidden></video>
          <span class="lock-tag">🔒 {esc(t['short'])}</span>
{short_chip(t)}
        </div>
      </div>
      <aside class="c-panel card">
{model_switch(t)}
        <h2 class="c-h">Photos</h2>
        <div class="drop images" id="image-drop">
          <input type="file" id="image-input" accept="image/jpeg,image/png,image/webp" hidden />
          <div class="drop-empty" id="image-empty"></div>
          <div class="thumbs" id="thumbs" hidden></div>
        </div>
        <p class="c-note">One person per photo, facing the camera, good light, no sunglasses.</p>
        <div class="c-head"><h2 class="c-h"><label for="prompt">Prompt</label></h2>
          <button type="button" class="link-btn" id="prompt-reset" hidden>↺ Reset to default</button></div>
        <textarea id="prompt" rows="4" maxlength="2000">{esc(t['prompt'])}</textarea>
        <h2 class="c-h">Resolution</h2>
{RES_ROW}{STARTED_NOTE}      </aside>
    </section>
"""


def example_section(t, root):
    """A real result made with this trend (design C pages); the hero's "See an example result" links here."""
    rs = t.get("result_sample")
    if not rs:
        return ""
    return f"""    <section class="example-result" id="example">
      <h2>Example result</h2>
      <figure class="ex-video">
        <video src="{rel(root, rs['video'])}" poster="{rel(root, rs['poster'])}" muted loop playsinline preload="none" data-autoplay></video>
        <button type="button" class="eq-sound" aria-label="Play with sound"
          onclick="const v=this.previousElementSibling;v.muted=!v.muted;v.play();this.textContent=v.muted?'🔇':'🔊';this.ariaLabel=v.muted?'Play with sound':'Mute'">🔇</button>
      </figure>
      <p class="muted">An example result made with Genjutsu from {photos_text(t)}.</p>
    </section>
"""


def studio_trend(t, root):
    n = len(t["slots"])
    rs = t.get("result_sample")
    result = f"""      <div class="eq-result" id="example">
        <span class="eq-op">=</span>
        <figure class="eq-video">
          <video src="{rel(root, rs['video'])}" poster="{rel(root, rs['poster'])}" muted loop playsinline preload="none" data-autoplay></video>
          <span class="eq-tag">Example result</span>
          <button type="button" class="eq-sound" aria-label="Play with sound"
            onclick="const v=this.previousElementSibling.previousElementSibling;v.muted=!v.muted;v.play();this.textContent=v.muted?'🔇':'🔊';this.ariaLabel=v.muted?'Play with sound':'Mute'">🔇</button>
        </figure>
      </div>
""" if rs else ""
    return f"""    <section class="card studio" id="studio">
      <div class="preset-bar">
        <span class="trend">🔥 Trending</span>
        <span>The scene is ready. Add {photos_text(t)}, then hit Generate.</span>
      </div>
      <div class="grid2 eq">
        <div class="drop locked" id="video-drop">
          <video id="video-preview" muted loop playsinline autoplay hidden></video>
          <span class="lock-tag">🔒 {esc(t['short'])}</span>
          <button type="button" class="eq-sound" aria-label="Play with sound"
            onclick="const v=document.getElementById('video-preview');v.muted=!v.muted;v.play();this.textContent=v.muted?'🔇':'🔊';this.ariaLabel=v.muted?'Play with sound':'Mute'">🔇</button>
        </div>
        <span class="eq-op eq-plus">+</span>
        <div class="drop images" id="image-drop">
          <input type="file" id="image-input" accept="image/jpeg,image/png,image/webp" hidden />
          <div class="drop-empty" id="image-empty"></div>
          <div class="thumbs" id="thumbs" hidden></div>
        </div>
      </div>
{result}      <ul class="photo-tips">
        <li class="ok">One person per photo</li><li class="ok">Face the camera</li><li class="ok">Good light</li>
        <li class="no">No sunglasses</li><li class="no">No group shots</li>
      </ul>
{prompt_block(t)}{model_row(t)}{RES_ROW}{STARTED_NOTE}    </section>
"""


STUDIO_CUSTOM = """    <section class="card studio" id="studio">
      <div class="mode-switch" role="tablist">
        <button class="mode active" data-mode="motion-transfer" role="tab">
          <span class="mode-title">Motion transfer</span>
          <span class="mode-sub">Your photos perform the video's motion</span>
        </button>
        <button class="mode" data-mode="object-swap" role="tab">
          <span class="mode-title">Object swap</span>
          <span class="mode-sub">Replace one person or object in the video</span>
        </button>
      </div>

      <div class="grid2">
        <label class="drop" id="video-drop" tabindex="0" role="button" aria-label="Upload a source video">
          <input type="file" id="video-input" accept="video/mp4" hidden />
          <div class="drop-empty">
            <div class="drop-icon">🎬</div>
            <div class="drop-title">Your video</div>
            <div class="drop-hint">MP4, 4–30 seconds</div>
          </div>
          <video id="video-preview" muted loop playsinline hidden></video>
          <button type="button" class="x" id="video-clear" hidden aria-label="Remove video">×</button>
        </label>

        <div class="drop images" id="image-drop">
          <input type="file" id="image-input" accept="image/jpeg,image/png,image/webp" multiple hidden />
          <div class="drop-empty" id="image-empty">
            <div class="drop-icon">🖼️</div>
            <div class="drop-title">Reference photos</div>
            <div class="drop-hint">JPG / PNG / WEBP, 1–8 photos</div>
          </div>
          <div class="thumbs" id="thumbs" hidden></div>
        </div>
      </div>

      <label class="field">
        <span>Prompt <em>(optional)</em></span>
        <textarea id="prompt" rows="2" maxlength="2000" placeholder="e.g. Replace both characters with the uploaded pictures"></textarea>
      </label>

      <div class="custom-model">
        <div class="c-row">
          <b>Model</b>
          <button type="button" class="switch" id="model-switch" role="switch" aria-checked="false" aria-label="Premium">
            <span class="lbl on" data-m="light">Budget</span><span class="track"><span class="ball"></span></span><span class="lbl" data-m="full">Premium</span>
          </button>
        </div>
        <p class="c-note" id="model-note">Budget · fast and cheap · videos up to 15 seconds.</p>
      </div>
""" + RES_ROW + STARTED_NOTE + """    </section>
"""


PAGE_HASH = {}  # page path -> hash of its content (minus the asset version), for the sitemap's lastmod


def write(rel, content):
    if rel.endswith("index.html"):
        # Lists that follow the gallery ranking (<!--rank-->…<!--/rank-->) reorder with popularity; that isn't a content change.
        stable = re.sub(r"<!--rank-->.*?<!--/rank-->", "", re.sub(r"\?v=[0-9a-f]{10}", "", content), flags=re.S)
        PAGE_HASH[rel[: -len("index.html")]] = hashlib.sha1(stable.encode()).hexdigest()
    p = DOCS / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    print("wrote", rel)


LIGHT_CREDITS_PER_SEC_DEFAULT = 15  # 480p Genjutsu Light (2 x $0.05 x 1.5 x 100); keep in sync with docs/config.js


def trend_credits(t):
    light = t.get("model") == "light"
    secs = min(15 if light else 30, max(4, math.ceil(t["duration"] - 0.001)))  # every started second, like Higgsfield and app.js clampSecs
    return math.ceil(secs * (LIGHT_CREDITS_PER_SEC_DEFAULT if light else CREDITS_PER_SEC_DEFAULT) - 1e-9) + FEE_CREDITS


def price_chip(t):
    """Cheapest real price first (AI answers quote the first price they see), then Premium mode."""
    if has_light(t):
        lt = dict(t, model="light", duration=t["light_duration"])
        return f"<b>From ${trend_credits(lt) / 100:.2f}</b> (Budget mode, 480p) · Premium: {price_text(dict(t, model='full'))}"
    return f"<b>From ${trend_credits(t) / 100:.2f}</b> (Premium, 480p, {trend_credits(t):,} credits)"


def price_text(t):
    credits = trend_credits(t)
    return f"{credits:,} credits (≈ ${credits / 100:.2f}) at 480p"


def media_secs(path):
    """Duration in whole seconds of a local docs/ video (VideoObject), or None."""
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(DOCS / path)],
                             capture_output=True, text=True, timeout=20).stdout
        return max(1, round(float(out.strip())))
    except Exception:
        return None


def added_on(path):
    """The day a file was first committed (a real upload date for VideoObject), today if it's new."""
    out = subprocess.run(["git", "log", "--diff-filter=A", "--format=%cI", "--", str(DOCS / path)],
                         capture_output=True, text=True, cwd=ROOT).stdout.split()
    return out[-1] if out else TODAY + "T00:00:00+00:00"


def card_img(t):
    """A 720 px copy of the poster for the home cards (the full poster weighs ~3x more), made with ffmpeg.
    The name carries the poster's hash, so a new poster gets a new URL and the 7-day cache can't serve the old one."""
    src = (DOCS / t["poster"]).resolve()
    if t["poster"].startswith("http") or not src.exists():
        return t["poster"]
    if not src.is_relative_to(DOCS.resolve()):
        raise ValueError(f"poster outside docs/: {t['poster']!r}")
    name = f"card-{hashlib.sha256(src.read_bytes()).hexdigest()[:10]}.jpg"
    out = src.parent / name
    if not out.exists():
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vf", "scale='min(720,iw)':-2:flags=lanczos",
                        "-q:v", "6", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", str(out)], check=True, timeout=60)
    for old in src.parent.glob("card-*.jpg"):
        if old != out:
            old.unlink()
    return str(out.relative_to(DOCS.resolve()))


def video_aspect(t):
    """The preview video's own width/height (cards keep the clip's shape); 9/16 if ffprobe can't tell."""
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height",
                              "-of", "csv=p=0", str(DOCS / t.get("preview_url", ""))], capture_output=True, text=True, timeout=20).stdout
        w, h = (int(x) for x in out.strip().split(",")[:2])
        return f"{w} / {h}" if w > 0 and h > 0 else "9 / 16"
    except Exception:
        return "9 / 16"


def card_title(t):
    """Short card title: the name before ':', or the trend's short name if another trend shares it."""
    base = t["name"].split(":")[0].strip()
    return t["short"] if sum(1 for x in TRENDS if x["name"].split(":")[0].strip() == base) > 1 else base


# Words that don't make two trends siblings (bad-times-baby and industry-baby aren't related).
_GENERIC = {"the", "dance", "baby", "man", "car", "i", "feel", "like", "lights", "off", "turn", "your", "style"}


def related(t, n=4):
    """In-page links to similar trends: same family first (bad-times-*, thriller-*), then the trends ranked just
    after this one in the gallery, so every trend page gets a few links from other trend pages."""
    words = set(t["slug"].split("-")) - _GENERIC
    i = next((k for k, x in enumerate(TRENDS) if x["slug"] == t["slug"]), -1)
    ring = [x for x in TRENDS[i + 1:] + TRENDS[:max(i, 0)] if x["slug"] != t["slug"]]
    family = [x for x in ring if words & set(x["slug"].split("-"))]
    return (family + [x for x in ring if x not in family])[:n]


# ---------------- trend pages ----------------
for t in ALL_TRENDS:
    path = f"trends/{t['slug']}/"
    root = "../../"
    s = t["seo"]
    page = {"kind": "trend", "trend": {
        **{k: t[k] for k in ("slug", "short", "video_url", "mode", "resolution", "prompt")}, "model": t.get("model", "full"), "duration": t["duration"],
        "light_video_url": t.get("light_video_url"), "light_duration": t.get("light_duration"),
        "light_preview_url": rel(root, t["light_preview_url"]) if t.get("light_preview_url") else None,
        "poster": rel(root, t["poster"]),
        "preview_url": rel(root, t.get("preview_url", t["video_url"])),
        "slots": [{**s, "example": rel(root, s["example"]) if s.get("example") else None} for s in t["slots"]],
        "min_photos": t.get("min_photos", len(t["slots"])),
    }}
    howto = {
        "@context": "https://schema.org", "@type": "HowTo", "name": f"How to make the {t['name']} AI video",
        "image": og_image(path, t), "totalTime": "PT5M",
        "step": [{"@type": "HowToStep", "position": i + 1, "name": n, "text": x} for i, (n, x) in enumerate(s["steps"])],
    }
    low = trend_credits(dict(t, model="light", duration=t["light_duration"])) if has_light(t) else trend_credits(dict(t, model="full"))
    app_ld = {
        "@context": "https://schema.org", "@type": "WebApplication", "name": f"{t['name']} AI video generator",
        "url": BASE + path, "applicationCategory": "MultimediaApplication", "operatingSystem": "Any (web browser)",
        "description": s["description"], "image": og_image(path, t),
        # same lowest price as the Product offer below, so the two can't disagree
        "offers": {"@type": "Offer", "price": f"{low / 100:.2f}", "priceCurrency": "USD", "url": BASE + path},
    }
    # Product markup (ChatGPT shopping / Google product results): the trend video at its lowest real price,
    # i.e. what the page itself shows first (Light at 480p when the trend has a Light clip).
    product_ld = None if t.get("hidden") else {
        "@context": "https://schema.org", "@type": "Product", "name": f"{t['name']} AI video",
        "description": s["description"], "image": og_image(path, t), "url": BASE + path,
        "brand": {"@type": "Brand", "name": "Genjutsu Studio"}, "category": "AI video generation",
        "offers": {"@type": "Offer", "url": BASE + path, "priceCurrency": "USD", "price": f"{low / 100:.2f}",
                   "availability": "https://schema.org/InStock",
                   # Digital product delivered online: free and instant. Matches the Terms: finished videos
                   # can't be returned; failed or blocked renders are refunded automatically (credits).
                   "shippingDetails": {"@type": "OfferShippingDetails",
                                       "shippingRate": {"@type": "MonetaryAmount", "value": "0", "currency": "USD"},
                                       "shippingDestination": {"@type": "DefinedRegion", "addressCountry": "US"},
                                       "deliveryTime": {"@type": "ShippingDeliveryTime",
                                                        "handlingTime": {"@type": "QuantitativeValue", "minValue": 0, "maxValue": 0, "unitCode": "DAY"},
                                                        "transitTime": {"@type": "QuantitativeValue", "minValue": 0, "maxValue": 0, "unitCode": "DAY"}}},
                   "hasMerchantReturnPolicy": {"@type": "MerchantReturnPolicy", "applicableCountry": "US",
                                               "returnPolicyCategory": "https://schema.org/MerchantReturnNotPermitted",
                                               "merchantReturnLink": f"{BASE}terms/"},
                   "seller": {"@type": "Organization", "name": "Genjutsu Studio", "url": BASE}},
    }
    rs = t.get("result_sample")
    video_ld = None if t.get("hidden") or not rs else {
        "@context": "https://schema.org", "@type": "VideoObject", "name": f"Example result: {t['short']} AI video",
        "description": f"An example result made with Genjutsu from {photos_text(t)}.",  # same words as the page caption
        "thumbnailUrl": abs_url(rs["poster"]), "contentUrl": abs_url(rs["video"]), "uploadDate": added_on(rs["video"]),
        **({"duration": f"PT{media_secs(rs['video'])}S"} if media_secs(rs["video"]) else {}),
    }
    all_faq = s["faq"] + [x for x in extra_faq(t) if x[0] not in {f[0] for f in s["faq"]}]
    steps = "\n".join(f"        <li><b>{esc(n)}.</b> {esc(x)}</li>" for n, x in s["steps"])
    body = head(path=path, title=s["title"], description=s["description"], og_title=s.get("og_title"),
                image=og_image(path, t), noindex=bool(t.get("hidden")),
                extra_ld=ld(app_ld, product_ld, video_ld, howto, faq_ld(all_faq), breadcrumbs(("Trends", ""), (t["short"], path))))
    body += header(root)
    body += f"""
  <main>
    <div class="crumbs"><a href="{root}">Trends</a> › {esc(t['short'])}</div>
    <section class="hero small">
      <h1>{esc(s['h1'])}</h1>
      <p class="lead">{s['lead']}</p>
      <p class="price-chip">{price_chip(t)} · no subscription</p>
      {'<p><a class="see-example" href="#example">▶ See an example result</a></p>' if t.get("result_sample") else ''}
    </section>

{studio_trend_c(t, root)}{example_section(t, root)}
    <section class="seo">
      <h2>About the trend</h2>
      {s['about_html']}
      <h2>How to make it</h2>
      <ol>
{steps}
      </ol>
{photo_tips(t)}{price_section(t)}    </section>

    <section class="faq">
      <h2>Questions</h2>
{faq_html(all_faq)}
    </section>

    <section class="more">
      <h2>More trends</h2>
      <p>Similar trends: <!--rank-->{" · ".join(f'<a href="{root}trends/{x["slug"]}/">{esc(card_title(x))}</a>' for x in related(t))}<!--/rank-->.</p>
      <p><a href="{root}">Browse all trends</a> or make your own on the <a href="{root}custom/">Custom</a> page.</p>
    </section>
  </main>

"""
    body += footer(root, page=page)
    write(f"{path}index.html", body)

# ---------------- home ----------------
# The first row of posters is the home page's LCP: load it right away, lazy-load the rest.
FIRST_ROW = 4
cards = "\n".join(f"""        <a class="trend-card" href="trends/{t['slug']}/">
          <div class="tc-media" style="aspect-ratio: {video_aspect(t)}"><img src="{esc(rel('', card_img(t)))}" alt="{esc(t['name'])} AI video trend" {'fetchpriority="high"' if i == 0 else 'loading="eager"' if i < FIRST_ROW else 'loading="lazy"'} /><video data-src="{rel('', t.get('preview_url', t['video_url']))}" loop playsinline preload="none"></video><span class="tc-badge">🔥 Trending</span><span class="tc-sound" hidden>🔇</span></div>
          <div class="tc-body"><b>{esc(card_title(t))}</b></div>
        </a>""" for i, t in enumerate(TRENDS))
home_faq = [
    ("What is Genjutsu Studio?", "A site that lets you make viral AI video trends with Higgsfield's Genjutsu model. Pick a trend, add your photos and generate. No subscription."),
    ("How does it work?", "Every trend page has its scene already loaded. You only add a photo for each person. On the Custom page you can upload your own video, up to 8 photos and your own prompt."),
    ("How much does it cost?", "You pay per second of video, with no subscription. At 480p it's 15 credits per second in Budget mode (Genjutsu Light, up to 15 seconds) or about 48 in Premium mode, plus 100 per video (100 credits = $1). Every page shows the exact price before you generate."),
    ("What if the generation fails?", "Your credits are refunded automatically, including when the content is blocked by moderation."),
    ("Can I close the page while it's generating?", "Yes. Your video keeps rendering. Sign in again and you'll find it under \"My videos\" in the top menu."),
    ("Do credits expire?", "No. Credits stay on your account until you use them."),
]
item_list = {
    "@context": "https://schema.org", "@type": "ItemList", "name": "Genjutsu AI video trends",
    "itemListElement": [{"@type": "ListItem", "position": i + 1, "url": f"{BASE}trends/{t['slug']}/", "name": t["name"]} for i, t in enumerate(TRENDS)],
}
site_ld = {"@context": "https://schema.org", "@type": "WebSite", "name": "Genjutsu Studio", "url": BASE}
org_ld = {"@context": "https://schema.org", "@type": "Organization", "name": "Genjutsu Studio", "url": BASE,
          "logo": f"{BASE}icon-512.png", "email": "support@genjutsu-trends.com"}
home = head(path="", title="Genjutsu AI Video Trends: Put Your Faces in Viral Scenes (No Subscription)",
            description="Make the viral AI video trends with Higgsfield Genjutsu: White Chicks \"A Thousand Miles\" and more. The scene is preloaded, add your photos and generate. No subscription.",
            og_title="Genjutsu AI Video Trends: Your Faces in Viral Scenes", image=f"{BASE}og.jpg",
            extra_ld=ld(site_ld, org_ld, item_list, faq_ld(home_faq)))
home += header("", active="trends")
home += f"""
  <main>
    <section class="hero">
      <h1>Viral AI video trends, with your faces</h1>
      <p class="lead">Pick a trending scene, add photos of you and your friends, and get the video in minutes.
        Made with <a href="genjutsu/">Higgsfield Genjutsu</a>. No subscription, pay per video.</p>
    </section>

    <section class="trend-grid">
{cards}
        <a class="trend-card custom" href="custom/">
          <div class="tc-media tc-custom"><span>✨</span></div>
          <div class="tc-body"><b>Custom trend</b></div>
        </a>
    </section>

    <section class="seo">
      <h2>What is a Genjutsu trend?</h2>
      <p>Genjutsu is Higgsfield's video-to-video model, released on August 31, 2026. It keeps the motion, camera move and timing of a clip and recasts the
        people from your photos. That's why it's behind the AI meme remakes going viral on TikTok, Reels and Shorts. Each trend here has its scene already
        loaded, so you only add the photos.</p>
    </section>

    <section class="faq">
      <h2>Questions</h2>
{faq_html(home_faq)}
    </section>
  </main>

"""
home += footer("", page={"kind": "home"})
write("index.html", home)

# ---------------- custom ----------------
custom_faq = [
    ("What can I make on the Custom page?", "Upload any MP4 between 4 and 30 seconds, add 1 to 8 reference photos and, optionally, a prompt. Motion transfer recasts the people in the clip; object swap replaces one person or object."),
    ("What prompt should I write?", "Keep it short and concrete, e.g. \"Replace both characters with the uploaded pictures\" or \"Replace the man in the red shirt with the person in the photo\"."),
    ("How much does it cost?", "You pay per second of the source video. Budget mode (motion transfer, videos up to 15 s) costs 15 credits per second at 480p; Premium mode (up to 30 s) costs about 48 credits per second at 480p. Both add 100 credits per video (100 credits = $1). The exact price shows before you generate."),
    ("What's the difference between Budget and Premium?", "Budget (the Genjutsu Light model) is fast and cheap and works with motion transfer on videos up to 15 seconds. Premium mode has more detail, supports object swap and videos up to 30 seconds, and costs more."),
]
custom = head(path="custom/", title="Custom Genjutsu Video: Upload Any Clip and Photos (No Subscription)",
              description="Make your own AI video trend with Higgsfield Genjutsu: upload a 4–30 second clip, up to 8 photos and your own prompt. Motion transfer or object swap, pay per video.",
              image=f"{BASE}og.jpg", extra_ld=ld(faq_ld(custom_faq), breadcrumbs(("Trends", ""), ("Custom trend", "custom/"))))
custom += header("../", active="custom")
custom += f"""
  <main>
    <div class="crumbs"><a href="../">Trends</a> › Custom trend</div>
    <section class="hero small">
      <h1>Custom trend</h1>
      <p class="lead">Start your own trend: upload any video, add up to 8 photos and tell Genjutsu what to change.</p>
    </section>

{STUDIO_CUSTOM}
    <section class="faq">
      <h2>Questions</h2>
{faq_html(custom_faq)}
    </section>
  </main>

"""
custom += footer("../", page={"kind": "custom"})
write("custom/index.html", custom)

# ---------------- genjutsu article ----------------
gfaq = json.loads((SITE / "genjutsu_faq.json").read_text())
g = head(path="genjutsu/", title="Higgsfield Genjutsu Trend Videos: Pay Per Video",
         description="Make trend videos with Higgsfield's Genjutsu model (motion transfer and object swap), pay per video. Limits, price per second, and how it works. Independent site, not affiliated with Higgsfield.",
         og_type="article", image=f"{BASE}og.jpg", extra_ld=ld(faq_ld(gfaq), breadcrumbs(("Trends", ""), ("Higgsfield Genjutsu", "genjutsu/"))))
g += header("../", app=False)
g += f"""  <main>
    <article class="article">
      <div class="crumbs"><a href="../">Trends</a> › Higgsfield Genjutsu</div>
      <h1>Genjutsu Trend Videos, Pay Per Video</h1>
{(SITE / 'genjutsu_body.html').read_text()}    </article>
  </main>
"""
g += footer("../", app=False)
write("genjutsu/index.html", g)

# ---------------- pricing ----------------
FROM_PRICE = min(trend_credits(dict(t, model="light", duration=t["light_duration"])) for t in TRENDS if has_light(t)) / 100


def light_price(secs, res):
    secs = min(15, max(4, -(-secs // 1)))
    return (math.ceil(secs * LIGHT_RATES[res] - 1e-9) + FEE_CREDITS) / 100


def video_price(secs, res):
    secs = min(30, max(4, -(-secs // 1)))
    return (math.ceil(secs * RATES[res] - 1e-9) + FEE_CREDITS) / 100


pfaq = [
    ("Is there a subscription?", "No. There is no monthly plan and nothing renews. You pay once for the video you are making."),
    ("Do I have to buy credits I won't use?", "No. At checkout, pick \"Just this video\" and you pay exactly that video's price ($2 minimum). Packs are optional, for people who plan to make several videos."),
    ("How is the price calculated?", "By the length of the video, the resolution and the mode: Budget mode (Genjutsu Light) uses 15 seconds of the scene and costs much less; Premium mode renders the full scene with more detail. The exact price shows before you click Generate."),
    ("What if the video fails?", "Failed or moderated generations are refunded automatically to your balance."),
    ("Why do some apps look cheaper?", "Subscription apps advertise \"up to\" numbers based on their cheapest model and shortest clip, and you pay every month whether you use it or not. Here you pay only when you make a video, with Higgsfield Genjutsu, the model that keeps the original scene."),
]
pr = head(path="pricing/", title="Pricing: Pay Per Video, No Subscription | Genjutsu Studio",
          description=f"Genjutsu Studio pricing: pay once for the video you make. No subscription, no unused credits. Trend videos from about ${FROM_PRICE:.2f} at 480p.",
          image=f"{BASE}og.jpg", extra_ld=ld(faq_ld(pfaq), breadcrumbs(("Trends", ""), ("Pricing", "pricing/"))))
pr += header("../", app=False, active="pricing")
pr += f"""  <main>
    <article class="article">
      <div class="crumbs"><a href="../">Trends</a> › Pricing</div>
      <h1>Pay per video. That's it.</h1>
      <p class="lead">No subscription, no monthly credits that expire. You pay for the video you're making, right when you make it.</p>
      <div class="price-points">
        <div><b>🚫 No subscription</b><span>Nothing renews. No plan to cancel.</span></div>
        <div><b>🎯 Pay for just this video</b><span>Checkout charges exactly this video's price ($2 minimum).</span></div>
        <div><b>↩️ Failed = refunded</b><span>If it fails or is moderated, you get it back.</span></div>
      </div>

      <h2>How the price is calculated</h2>
      <p>The price depends on the mode, how long the video is and the resolution you pick. Every trend page has a switch between the two modes.</p>
      <h3>Budget mode (Genjutsu Light): fast and cheap, 15 seconds of the scene</h3>
      <table>
        <tr><th>Resolution</th><th>10-second video</th><th>15-second video</th></tr>
""" + "".join(f"        <tr><td>{r}</td>" + "".join(f"<td>${light_price(x, r):.2f}</td>" for x in (10, 15)) + "</tr>\n" for r in LIGHT_RATES) + f"""      </table>
      <h3>Premium (full Genjutsu model): full scene, more detail</h3>
      <table>
        <tr><th>Resolution</th><th>10-second video</th><th>20-second video</th><th>30-second video</th></tr>
""" + "".join(f"        <tr><td>{r}</td>" + "".join(f"<td>${video_price(x, r):.2f}</td>" for x in (10, 20, 30)) + "</tr>\n" for r in RATES) + f"""      </table>
      <p>480p is the default and looks fine on TikTok, Reels and Shorts. The exact price for every trend and for your own clip on the <a href="../custom/">Custom</a> page is shown before you click Generate.</p>

      <h2>Why not a subscription?</h2>
      <p>Most AI video apps sell a monthly plan with a pile of credits. You pay every month, the \"up to 60 videos\" assumes their cheapest model and shortest clip, and unused credits disappear. You usually want one video for one trend, so that's what you pay for here.</p>

      <h2>Optional packs</h2>
      <p>Making a few videos? Packs add a small bonus: $5 = 500 credits, $15 = 1,600 credits (+7%), $40 = 4,500 credits (+12%). 100 credits = $1. You never need one: \"Just this video\" is always an option at checkout.</p>

      <h2>Questions</h2>
{faq_html(pfaq)}
    </article>
  </main>
"""
pr += footer("../", app=False)
write("pricing/index.html", pr)

# ---------------- watch (public share links) ----------------
# One page per trend (watch/<slug>/), so link previews (WhatsApp, X, iMessage) show that trend's image and
# name: crawlers don't run JS. watch/ itself is the generic page (custom videos, old links).
def watch_page(path, root, title, image):
    w = head(path=path, title=f"{title} | Genjutsu Studio",
             description="An AI trend video made with Genjutsu. Make your own in minutes.", image=image, noindex=True)
    w += header(root, app=False)
    w += f"""  <main>
    <section class="hero small watch">
      <p class="muted" id="watch-loading">Loading the video…</p>
      <div id="watch-found" hidden>
        <h1 id="watch-title">Made with Genjutsu</h1>
        <video id="watch-video" controls playsinline autoplay muted loop hidden></video>
        <p><a class="btn primary big" id="watch-cta" href="{root}">Make your own AI video →</a></p>
        <p class="muted">Pick a viral trend, add your photos, get your video in minutes. Pay per video, no subscription.</p>
      </div>
      <div id="watch-missing" hidden>
        <h1>This video isn't available</h1>
        <p class="muted">The link may be wrong, or the owner deleted the video.</p>
        <p><a class="btn primary big" href="{root}">Browse trends →</a></p>
      </div>
    </section>
  </main>
  <script src="{root}config.js?v={ASSET_VER}"></script>
  <script src="{root}watch.js?v={ASSET_VER}"></script>
"""
    w += footer(root, app=False)
    write(f"{path}index.html", w)


watch_page("watch/", "../", "Watch this AI video", f"{BASE}og.jpg")
BY_SLUG = {t["slug"]: t for t in ALL_TRENDS}
for slug, name in trend_names().items():  # every slug a job can carry, incl. hidden and retired ones
    t = BY_SLUG.get(TREND_ALIASES.get(slug, slug))
    watch_page(f"watch/{slug}/", "../../", f"Watch this {name} AI video", og_image(f"trends/{t['slug']}/", t) if t else f"{BASE}og.jpg")

# ---------------- my videos (private, per user) ----------------
mv = head(path="my-videos/", title="My videos | Genjutsu Studio", description="Your Genjutsu videos: follow, watch and download them.",
          image=f"{BASE}og.jpg", noindex=True)
mv += header("../", active="videos")
mv += f"""  <main>
    <div class="crumbs"><a href="../">Trends</a> › My videos</div>
    <section class="hero small">
      <h1>My videos</h1>
      <p class="lead">Every video you've made: follow its progress, watch it and download it. Download your videos to keep a copy.</p>
    </section>
{HISTORY}  </main>
  <dialog id="share-modal" class="modal">
    <form method="dialog" class="modal-x"><button aria-label="Close">×</button></form>
    <h3>Share your video</h3>
    <p class="muted">Anyone with this link can watch the video. No sign-in needed.</p>
    <div class="share-row">
      <input id="share-url" type="text" readonly aria-label="Share link" />
      <button type="button" id="share-copy" class="btn primary">Copy link</button>
    </div>
    <div class="share-apps">
      <a id="share-wa" class="btn" target="_blank" rel="noopener noreferrer">WhatsApp</a>
      <a id="share-x" class="btn" target="_blank" rel="noopener noreferrer">X</a>
      <a id="share-fb" class="btn" target="_blank" rel="noopener noreferrer">Facebook</a>
      <button type="button" id="share-more" class="btn ghost" hidden>More…</button>
    </div>
    <p class="fine">Deleting the video turns this link off.</p>
  </dialog>
"""
mv += footer("../", page={"kind": "videos"})
write("my-videos/index.html", mv)

# ---------------- legal pages ----------------
LEGAL = [("terms", "Terms of Use", "Terms of use for Genjutsu Studio: credits, refunds, what you may upload, and your videos."),
         ("privacy", "Privacy", "What Genjutsu Studio collects, who processes it, and how long uploads are kept (7 days)."),
         ("accessibility", "Accessibility", "Accessibility statement for Genjutsu Studio (IS 5568 / WCAG 2.1 AA): what we've done, known limitations, and how to contact us.")]
for slug, title, desc in LEGAL:
    page = head(path=f"{slug}/", title=f"{title} | Genjutsu Studio", description=desc, image=f"{BASE}og.jpg",
                extra_ld=ld(breadcrumbs(("Trends", ""), (title, f"{slug}/"))))
    page += header("../", app=False)
    page += f"""  <main>
    <article class="article">
      <div class="crumbs"><a href="../">Trends</a> › {title}</div>
      <h1>{title}</h1>
{(SITE / 'legal' / f'{slug}.html').read_text()}    </article>
  </main>
"""
    page += footer("../", app=False)
    write(f"{slug}/index.html", page)

# ---------------- unsubscribe (link in marketing emails; not indexed) ----------------
unsub = head(path="unsubscribe/", title="Unsubscribe | Genjutsu Studio", description="Stop marketing emails from Genjutsu Studio.",
             image=f"{BASE}og.jpg", noindex=True)
unsub = unsub.replace("<head>", '<head>\n  <meta name="referrer" content="no-referrer" />', 1)  # the URL carries a token
unsub += header("../", app=False)
unsub += """  <main>
    <article class="article">
      <h1>Unsubscribe</h1>
      <p id="unsub-text">Stop emails about new trends and offers? You'll still get sign-in codes and emails about your own videos.</p>
      <p><button type="button" class="btn primary" id="unsub-btn">Unsubscribe</button></p>
    </article>
  </main>
  <script>
  (function () {
    var q = new URLSearchParams(location.search), u = q.get("u") || "", t = q.get("t") || "";
    var btn = document.getElementById("unsub-btn"), txt = document.getElementById("unsub-text");
    if (!u || !t) { txt.textContent = "This unsubscribe link is incomplete. Reply to any of our emails and we'll remove you."; btn.hidden = true; return; }
    btn.onclick = function () {
      btn.disabled = true;
      fetch("https://tbljgxkbocunzoqvkoeu.supabase.co/functions/v1/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ u: u, t: t }) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (x) { txt.textContent = x.ok ? "Done. You won't get any more marketing emails from us." : (x.j.error || "Something went wrong. Please try again."); btn.hidden = x.ok; btn.disabled = false; })
        .catch(function () { txt.textContent = "Something went wrong. Please try again."; btn.disabled = false; });
    };
  })();
  </script>
"""
unsub += footer("../", app=False)
write("unsubscribe/index.html", unsub)

# ---------------- old URLs → new pages ----------------
REDIRECTS = {"white-chicks-ai-trend/": "trends/white-chicks/", "trends/mafia-daughter/": "trends/storm/",
             "trends/hotel-lobby-v2/": "trends/hotel-lobby/", "trends/desert-truck-jump/": "trends/car-jump/"}
for old, new in REDIRECTS.items():
    write(f"{old}index.html", f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Moved</title>
<link rel="canonical" href="{BASE}{new}" /><meta name="robots" content="noindex" />
<meta http-equiv="refresh" content="0; url={BASE}{new}" /></head>
<body><p>This page moved to <a href="{BASE}{new}">{BASE}{new}</a>.</p></body></html>
""")

# Display names for the server's "video ready" emails (supabase/functions/_shared/email.ts).
write("trend-names.json", json.dumps(trend_names(), ensure_ascii=False))

# ---------------- sitemap / robots ----------------
# lastmod = the day a page's content last changed (site/lastmod.json keeps hash + day per page), not the build
# day: search engines ignore a lastmod that changes on every build.
urls = [("", "1.0"), ("custom/", "0.7"), ("pricing/", "0.8"), ("genjutsu/", "0.7"), ("terms/", "0.3"), ("privacy/", "0.3"), ("accessibility/", "0.3")] + [(f"trends/{t['slug']}/", "0.9") for t in TRENDS]
LASTMOD_FILE = SITE / "lastmod.json"
_seen = json.loads(LASTMOD_FILE.read_text()) if LASTMOD_FILE.exists() else {}
lastmod = {}
for u, _ in urls:
    h, old = PAGE_HASH[u], _seen.get(u)
    lastmod[u] = {"hash": h, "day": old["day"] if old and old["hash"] == h else TODAY}
LASTMOD_FILE.write_text(json.dumps(lastmod, indent=1, sort_keys=True) + "\n")
UPDATED = max(v["day"] for v in lastmod.values())
write("sitemap.xml", '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
      + "".join(f"  <url><loc>{BASE}{u}</loc><lastmod>{lastmod[u]['day']}</lastmod><priority>{p}</priority></url>\n" for u, p in urls)
      + "</urlset>\n")


# llms.txt (short) and llms-full.txt (every trend's facts, steps and FAQ): plain text for AI assistants
# (ChatGPT, Claude, Perplexity) answering "how do I make X". Facts only from trends.json and the price code.
def _low(t):
    return trend_credits(dict(t, model="light", duration=t["light_duration"])) if has_light(t) else trend_credits(dict(t, model="full"))


def _shape(t):
    try:
        w, h = (int(x) for x in video_aspect(t).split(" / "))
    except ValueError:
        return "vertical"
    return "vertical" if h > w * 1.05 else "horizontal" if w > h * 1.05 else "square"


def _facts(t):
    full = billed_secs(t["duration"], False)
    out = [f"{photos_text(t)} ({', '.join(sl['label'] for sl in t['slots'])})", f"{_shape(t)} MP4"]
    if has_light(t):
        ls = billed_secs(t["light_duration"], True)
        out.append(f"Budget mode (Genjutsu Light): {ls} s from ${_low(t) / 100:.2f}; Premium: "
                   + (f"same {full} s clip" if ls == full else f"full {full} s scene") + f" from ${trend_credits(dict(t, model='full')) / 100:.2f}")
    else:
        out.append(f"{full} s scene, Premium only, from ${_low(t) / 100:.2f}")
    return "; ".join(out)


def _aka(t):
    return f" Also called: {', '.join(t['aliases'])}." if t.get("aliases") else ""


def _text(h):
    t = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", h))
    return html.unescape(re.sub(r"\s+([,.;:!?)])", r"\1", t)).strip()


LLMS_HEAD = [f"# Genjutsu Studio ({BASE})", "",
             "> Make viral AI video trends with your own photos, in the browser. Pick a trend, upload a photo for each part, "
             "and Higgsfield's Genjutsu model puts you in the scene. Pay per video, no subscription, no app.", "",
             f"Last updated: {UPDATED}. Independent site: not affiliated with or endorsed by Higgsfield AI.", "",
             "## Pricing", f"- From ${FROM_PRICE:.2f} per video (Budget mode / Genjutsu Light, 480p). Premium mode and 720p/1080p cost more.",
             "- 100 credits = $1, credits never expire, failed or blocked renders are refunded automatically.",
             f"- Full price list: {BASE}pricing/", ""]
LLMS_TAIL = ["", "## Other pages", f"- [Custom trend]({BASE}custom/): upload any 4–30 s MP4 (up to 15 s in Budget mode), 1–8 photos and your own prompt.",
             f"- [About Genjutsu]({BASE}genjutsu/): what the model does and how this site uses it.", ""]
llms = LLMS_HEAD + ["## Trends (one page each, scene preloaded)",
                    f"- Every trend's facts, steps and FAQ: {BASE}llms-full.txt"]
llms += [f"- [{t['name']}]({BASE}trends/{t['slug']}/): {t['card_blurb']} {_facts(t)}.{_aka(t)}" for t in TRENDS if not t.get("hidden")]
write("llms.txt", "\n".join(llms + LLMS_TAIL))

full = LLMS_HEAD + ["## Trends"]
for t in TRENDS:
    s = t["seo"]
    faq = s["faq"] + [x for x in extra_faq(t) if x[0] not in {f[0] for f in s["faq"]}]
    full += ["", f"### {t['name']}", f"URL: {BASE}trends/{t['slug']}/", f"Facts: {_facts(t)}.{_aka(t)}", "",
             _text(s["about_html"]), "", "How to make it:"]
    full += [f"{i + 1}. {n}: {x}" for i, (n, x) in enumerate(s["steps"])]
    full += ["", "Questions:"] + [f"- Q: {q}\n  A: {a}" for q, a in faq]
write("llms-full.txt", "\n".join(full + LLMS_TAIL))
write("robots.txt", f"User-agent: *\nAllow: /\nSitemap: {BASE}sitemap.xml\n")
