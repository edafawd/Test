// Pyinsect report relay (Cloudflare Worker).
// 1. The website sends each invasive-species report here; this worker checks it and saves it to
//    reports/ in a PRIVATE GitHub repo with a token that only Cloudflare knows.
// 2. The reports page lives here too, at a secret address and behind a password:
//    https://<this worker>/<VIEW_PATH>/
//
// Settings (Cloudflare → this worker → Settings → Variables and Secrets):
//   GITHUB_TOKEN    Secret. Fine-grained token, Contents: Read and write on the repo below.
//   GITHUB_REPO     Text, e.g. edafawd/pyinsect-reports-data (private)
//   ALLOWED_ORIGIN  Text, e.g. https://edafawd.github.io
//   VIEW_PASSWORD   Secret. Password for the reports page.
//   VIEW_PATH       Secret. The secret word in the reports page address (letters, digits, - and _).

// Must match INVASIVE in index.html (scientific names, as Pyinsect 2.8+ outputs them)
const INVASIVE = new Set([
  "adelges_piceae", "agrilus_planipennis", "anisandrus_dispar", "anoplophora_glabripennis",
  "coptotermes_formosanus", "exomala_orientalis", "halyomorpha_halys", "harmonia_axyridis",
  "linepithema_humile", "lycorma_delicatula", "lymantria_dispar", "macrodactylus_subspinosus",
  "pieris_rapae", "polistes_dominula", "popillia_japonica", "solenopsis_invicta",
  "vespa_mandarinia", "xyleborus_monographus",
  // Older names (Pyinsect 2.7 and before), so reports still waiting on a phone go through
  "ambrosia_beetle", "argentine_ant", "asian_giant_hornet", "asian_lady_beetle",
  "asian_longhorned_beetle", "balsam_woolly_adelgid", "brown_marmorated_stink_bug",
  "cabbage_white", "elm_leaf_beetle", "emerald_ash_borer", "european_paper_wasp",
  "fire_ant", "formosan_termite", "japanese_beetle", "oriental_beetle", "rose_chafer",
  "spongy_moth", "spotted_lanternfly",
]);
const MAX_PHOTO_BYTES = 1.5 * 1024 * 1024;
const MAX_AGE_DAYS = 60;            // reports can wait offline on a phone for a while
const PER_IP_LIMIT = 30;            // reports per IP per hour (per Cloudflare server, best effort)
const WRONG_PASSWORD_LIMIT = 10;    // wrong passwords per IP per 15 minutes (best effort)
const SHOW = 40;                    // newest reports sent to the reports page
const LIST_CACHE_MS = 5000;         // GitHub is asked for the file list at most every 5 s

const ID_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-[0-9a-f]{1,8}$/;
const SPECIES_RE = /^[a-z_]{1,48}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
const recent = new Map(), wrong = new Map();
const reportCache = new Map();      // id → report JSON (reports never change)
let listCache = { at: 0, ids: null };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const word = viewWord(env);
    const view = word ? "/" + word : null;
    if (view && (url.pathname === view || url.pathname.startsWith(view + "/"))) {
      return viewer(request, env, url.pathname.slice(view.length));
    }
    return submit(request, env);
  },
};

// ---------- receiving reports from the website ----------

async function submit(request, env) {
  const cors = {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  const reply = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method === "GET") {
    // Says whether the reports page is set up, never what its address or password is
    return reply(200, { ok: true, service: "pyinsect-relay", version: 4, reports_page: Boolean(viewWord(env) && env.VIEW_PASSWORD) });
  }
  if (request.method !== "POST") return reply(405, { error: "Use POST." });
  const origin = request.headers.get("Origin");
  if (env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) return reply(403, { error: "Reports are only accepted from the Pyinsect site." });
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return reply(500, { error: "The relay isn't set up yet (GITHUB_TOKEN / GITHUB_REPO missing)." });

  const ip = request.headers.get("CF-Connecting-IP") || "?";
  if (!allow(recent, ip, 3600000, PER_IP_LIMIT)) return reply(429, { error: "Too many reports from this network. Try again later." });

  let body;
  try { body = await request.json(); } catch { return reply(400, { error: "Not valid JSON." }); }
  const checked = checkReport(body);
  if (checked.error) return reply(400, { error: checked.error });
  count(recent, ip, 3600000);

  const { report, photo } = checked;
  try {
    // Photo first, so the reports page only lists a report once its photo exists
    await githubCreate(env, `reports/${report.id}.jpg`, photo, `Photo for ${report.name} report`);
    await githubCreate(env, `reports/${report.id}.json`, toBase64(JSON.stringify(report, null, 1)), `Invasive species report: ${report.name}`);
  } catch (e) {
    return reply(502, { error: e.message });
  }
  listCache.at = 0;
  return reply(201, { ok: true, id: report.id });
}

// Accepts only well-formed invasive reports and rebuilds them from known fields
function checkReport(body) {
  const r = body && body.report, photo = body && body.photo;
  if (!r || typeof r !== "object") return { error: "Missing report." };

  const m = typeof r.id === "string" && r.id.match(ID_RE);
  if (!m) return { error: "Bad report id." };
  const when = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (isNaN(when) || when > Date.now() + 3600000 || when < Date.now() - MAX_AGE_DAYS * 86400000) {
    return { error: "Report time is out of range." };
  }
  if (!INVASIVE.has(r.species)) return { error: "Only invasive species are reported." };
  if (typeof r.timestamp !== "string" || !TIMESTAMP_RE.test(r.timestamp)) return { error: "Bad timestamp." };
  const pct = v => typeof v === "number" && v >= 0 && v <= 100;
  if (!pct(r.confidence)) return { error: "Bad confidence." };
  if (!Array.isArray(r.top3) || r.top3.length < 1 || r.top3.length > 3
      || !r.top3.every(t => t && SPECIES_RE.test(t.species) && pct(t.confidence))) {
    return { error: "Bad top-3 list." };
  }

  if (typeof photo !== "string" || photo.length > MAX_PHOTO_BYTES * 4 / 3 + 4) return { error: "Photo missing or too large." };
  let bytes;
  try { bytes = atob(photo); } catch { return { error: "Photo isn't valid base64." }; }
  if (bytes.charCodeAt(0) !== 0xFF || bytes.charCodeAt(1) !== 0xD8 || bytes.charCodeAt(2) !== 0xFF) {
    return { error: "Photo must be a JPEG." };
  }

  const short = (v, n) => typeof v === "string" ? v.slice(0, n) : "";
  // Display names come from the site; keep them short plain text, else fall back to the id
  const label = (v, species) => {
    const t = typeof v === "string" ? v.replace(/[^\p{L}\p{N} '().,-]/gu, "").trim().slice(0, 60) : "";
    return t || niceName(species);
  };
  return {
    photo,
    report: {
      id: r.id,
      timestamp: r.timestamp,
      species: r.species,
      name: label(r.name, r.species),
      scientific: label(r.scientific, r.species),
      confidence: r.confidence,
      top3: r.top3.map(t => ({ species: t.species, name: label(t.name, t.species), confidence: t.confidence })),
      photo: `${r.id}.jpg`,
      model: short(r.model, 40),
      app_version: short(r.app_version, 20),
    },
  };
}

// ---------- the password-protected reports page ----------

async function viewer(request, env, rest) {
  const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" };
  if (rest === "") return Response.redirect(new URL(request.url).href + "/", 301);
  if (rest === "/") return new Response(PAGE, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });

  if (!rest.startsWith("/api/")) return new Response("Not found", { status: 404, headers });
  if (!env.VIEW_PASSWORD || !env.GITHUB_TOKEN || !env.GITHUB_REPO) return json(500, { error: "The relay isn't fully set up (VIEW_PASSWORD / GITHUB_TOKEN / GITHUB_REPO)." });

  const ip = request.headers.get("CF-Connecting-IP") || "?";
  if (!allow(wrong, ip, 900000, WRONG_PASSWORD_LIMIT)) return json(429, { error: "Too many wrong passwords. Wait 15 minutes." });
  if (!(await samePassword(request.headers.get("X-Password") || "", env.VIEW_PASSWORD))) {
    count(wrong, ip, 900000);
    return json(401, { error: "Wrong password." });
  }

  try {
    if (rest === "/api/reports") return json(200, await latestReports(env));
    const photo = rest.match(/^\/api\/photo\/([0-9a-f-]{1,40})$/);
    if (photo && ID_RE.test(photo[1])) {
      const res = await githubRead(env, `reports/${photo[1]}.jpg`);
      if (!res) return json(404, { error: "No such photo." });
      return new Response(res.body, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable", "X-Robots-Tag": "noindex" } });
    }
    return json(404, { error: "Not found." });
  } catch (e) {
    return json(502, { error: e.message });
  }
}

// Newest reports, read from the private repo with the token (5,000 GitHub requests an hour)
async function latestReports(env) {
  if (!listCache.ids || Date.now() - listCache.at > LIST_CACHE_MS) {
    const res = await gh(env, `git/trees/HEAD?recursive=1`);
    let ids = [];
    if (res.ok) {
      const tree = (await res.json()).tree || [];
      const names = new Set(tree.map(t => t.path));
      ids = tree.map(t => t.path.match(/^reports\/(.+)\.json$/)).filter(Boolean).map(m => m[1])
        .filter(id => ID_RE.test(id) && names.has(`reports/${id}.jpg`))
        .sort().reverse();
    } else if (res.status !== 404 && res.status !== 409) {   // 404/409 = no files yet
      throw new Error(ghError(res.status));
    }
    listCache = { at: Date.now(), ids };
  }
  const ids = listCache.ids;
  // Cloudflare allows ~50 outgoing requests per visit, so load at most 40 new reports at a time
  const missing = ids.slice(0, SHOW).filter(id => !reportCache.has(id)).slice(0, 40);
  await Promise.all(missing.map(async id => {
    const res = await githubRead(env, `reports/${id}.json`);
    if (res) { try { reportCache.set(id, await res.json()); } catch {} }
  }));
  return { total: ids.length, reports: ids.slice(0, SHOW).filter(id => reportCache.has(id)).map(id => reportCache.get(id)) };
}

async function samePassword(given, real) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, real].map(s => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---------- GitHub ----------

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pyinsect-relay",
      ...(init.headers || {}),
    },
  });
}

function ghError(status) {
  if (status === 401) return "The relay's GitHub token was rejected (expired?).";
  if (status === 403 || status === 404) return "The relay's GitHub token can't use the reports repo.";
  return `GitHub answered ${status}.`;
}

// Creates a file; never overwrites (GitHub answers 422 when the file already exists)
async function githubCreate(env, path, base64, message) {
  const res = await gh(env, `contents/${path}`, { method: "PUT", body: JSON.stringify({ message, content: base64 }) });
  if (res.status === 422) return;   // already saved on an earlier try
  if (!res.ok) throw new Error(ghError(res.status));
}

// Raw file contents, or null if it doesn't exist
async function githubRead(env, path) {
  const res = await gh(env, `contents/${path}`, { headers: { Accept: "application/vnd.github.raw" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(ghError(res.status));
  return res;
}

// ---------- helpers ----------

// VIEW_PATH as typed in Cloudflare, tolerating spaces, slashes or a whole pasted link
function viewWord(env) {
  return (env.VIEW_PATH || "").trim().replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/^\/+|\/+$/g, "");
}

function allow(map, key, windowMs, limit) {
  const slot = Math.floor(Date.now() / windowMs), e = map.get(key);
  return !(e && e.slot === slot && e.n >= limit);
}
function count(map, key, windowMs) {
  const slot = Math.floor(Date.now() / windowMs), e = map.get(key);
  map.set(key, { slot, n: e && e.slot === slot ? e.n + 1 : 1 });
  if (map.size > 5000) map.clear();
}
function niceName(s) { return s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()); }
function toBase64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>Pyinsect Reports</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Same look as the site's assets/site.css (copied so this page works on its own) */
:root {
  --bg: #f3f5ef;
  --surface: #ffffff;
  --ink: #1d2a22;
  --muted: #5d6b61;
  --line: #d6ddd2;
  --accent: #2f6b45;
  --accent-soft: #e2ede3;
  --alert: #b3261e;
  --alert-soft: #fbe7e4;
  --display: "Bricolage Grotesque", "Segoe UI", system-ui, sans-serif;
  --body: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121814; --surface: #1a221d; --ink: #e4ebe5; --muted: #9aa89e; --line: #2c3830;
    --accent: #7cc193; --accent-soft: #1f3226; --alert: #ff8a7a; --alert-soft: #3a1d1a;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }   /* .btn and others set display, which would beat the hidden attribute */
body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--body); font-size: 15px; line-height: 1.5; }
.wrap { max-width: 820px; margin: 0 auto; padding: 32px 16px 64px; display: flex; flex-direction: column; gap: 28px; }
a { color: var(--accent); }
a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
header { display: flex; flex-direction: column; gap: 6px; }
nav { display: flex; gap: 16px; font-family: var(--mono); font-size: 13px; }
.eyebrow { font-family: var(--mono); font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
h1 { font-family: var(--display); font-weight: 700; font-size: clamp(30px, 6vw, 44px); line-height: 1.05; margin: 0; text-wrap: balance; }
h2 { font-family: var(--display); font-weight: 500; font-size: 19px; margin: 0; }
.muted { color: var(--muted); }
.status { font-family: var(--mono); font-size: 13px; color: var(--muted); }
.status.error { color: var(--alert); }

.hero { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 24px; background: var(--surface); border: 1px solid var(--alert); border-radius: 14px; padding: 18px; box-shadow: inset 5px 0 0 var(--alert); }
.hero img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 10px; background: var(--alert-soft); display: block; }
.hero .info { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.flag { align-self: flex-start; font-family: var(--mono); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; font-weight: 500; padding: 3px 9px; border-radius: 4px; background: var(--alert); color: var(--surface); }
.species { font-family: var(--display); font-weight: 700; font-size: clamp(28px, 5vw, 38px); line-height: 1.05; color: var(--alert); margin: 0; overflow-wrap: anywhere; }
.facts { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 0; font-size: 14px; }
.facts dt { font-family: var(--mono); font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; padding-top: 2px; }
.facts dd { margin: 0; font-variant-numeric: tabular-nums; }
.alts { display: flex; flex-direction: column; gap: 6px; }
.alt { display: grid; grid-template-columns: minmax(0, 1fr) 80px 46px; gap: 10px; align-items: center; font-size: 13px; }
.track { height: 6px; border-radius: 3px; background: var(--accent-soft); overflow: hidden; }
.fill { height: 100%; background: var(--accent); }
.pct { font-family: var(--mono); font-variant-numeric: tabular-nums; text-align: right; color: var(--muted); }

.ledger { display: flex; flex-direction: column; gap: 10px; }
.rows { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); overflow: hidden; }
.row { display: grid; grid-template-columns: 56px minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.row:last-child { border-bottom: none; }
.row img { width: 56px; height: 56px; object-fit: cover; border-radius: 6px; background: var(--accent-soft); display: block; }
.row .what { min-width: 0; }
.row .what strong { display: block; overflow-wrap: anywhere; }
.row .when { font-family: var(--mono); font-size: 12px; color: var(--muted); text-align: right; white-space: nowrap; }
.tally { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { font-size: 13px; padding: 4px 10px; border-radius: 999px; background: var(--alert-soft); color: var(--alert); font-weight: 500; }
.empty { padding: 22px; border: 1px dashed var(--line); border-radius: 12px; background: var(--surface); color: var(--muted); }

.actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.btn { font: 500 14px var(--body); color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 8px; padding: 9px 14px; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--surface); }
.btn.primary:hover { filter: brightness(1.08); color: var(--surface); }
.btn:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn svg { width: 16px; height: 16px; }
@media (max-width: 600px) {
  .hero { grid-template-columns: 1fr; }
  .row { grid-template-columns: 48px minmax(0, 1fr); }
  .row img { width: 48px; height: 48px; }
  .row .when { grid-column: 2; text-align: left; }
}
.sci { font-style: italic; font-size: 14px; color: var(--muted); margin-top: -6px; overflow-wrap: anywhere; }
.hero img, .row { cursor: zoom-in; }
.row:hover { background: var(--accent-soft); }
.row:focus-visible, .hero img:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.viewer { position: fixed; inset: 0; z-index: 10; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 16px; background: rgba(8, 12, 10, .82); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); cursor: zoom-out; }
.viewer img { display: block; max-width: 100%; max-height: calc(100vh - 150px); object-fit: contain; border-radius: 10px; background: #000; }
.viewer .caption { max-width: 820px; width: 100%; color: #eef3ef; display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: baseline; justify-content: center; text-align: center; font-size: 14px; }
.viewer .caption strong { font-family: var(--display); font-size: 22px; color: #fff; }
.viewer .caption em { color: #c7d2ca; }
.viewer .caption span { font-family: var(--mono); font-size: 12px; color: #c7d2ca; }
.viewer .close { position: absolute; top: 12px; right: 12px; color: #fff; background: rgba(255, 255, 255, .14); border-color: rgba(255, 255, 255, .3); }
.login { display: flex; flex-direction: column; gap: 10px; max-width: 360px; padding: 18px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
.login input[type=password] { font: 15px var(--mono); padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); }
.login label { font-size: 13px; color: var(--muted); display: flex; gap: 8px; align-items: center; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="eyebrow">Pyinsect field reports · private</span>
    <h1>Latest invasive find</h1>
    <span id="status" class="status">Loading…</span>
  </header>

  <form id="login" class="login" hidden>
    <strong>Enter the reports password</strong>
    <input id="pw" type="password" autocomplete="current-password" required>
    <label><input id="remember" type="checkbox" checked> Remember on this device</label>
    <div class="actions"><button class="btn primary" type="submit">Open reports</button><span id="loginMsg" class="status error"></span></div>
  </form>

  <section id="latest"></section>
  <section class="ledger" id="tallySection" hidden><h2 id="tallyTitle">Species reported</h2><div class="tally" id="tally"></div></section>
  <section class="ledger" id="earlierSection" hidden><h2>Earlier reports</h2><div class="rows" id="earlier"></div></section>
  <div class="actions" id="logoutBox" hidden><button id="logout" class="btn" type="button">Log out on this device</button></div>
</div>

<div id="viewer" class="viewer" role="dialog" aria-modal="true" aria-label="Full photo" hidden>
  <button id="viewerClose" class="btn close" type="button">Close</button>
  <img id="viewerImg" alt="">
  <div id="viewerCaption" class="caption"></div>
</div>

<script>
var REFRESH_MS = 15000, KEY = "pyinsect.viewpw";
var $ = function (id) { return document.getElementById(id); };
var password = null, timer = null, photoUrls = {};
try { password = localStorage.getItem(KEY) || sessionStorage.getItem(KEY); } catch (e) {}

function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function niceName(s) { return s.replace(/_/g, " ").replace(/\\b\\w/g, function (c) { return c.toUpperCase(); }); }
function when(iso) {
  var d = new Date(iso); if (isNaN(d)) return { ago: iso, full: iso };
  var m = Math.round((Date.now() - d) / 60000);
  var ago = m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " days ago";
  return { ago: ago, full: d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) };
}

function api(path) {
  return fetch("api/" + path, { headers: { "X-Password": password || "" }, cache: path === "reports" ? "no-store" : "default" });
}

// Photos need the password header, so they're fetched as blobs (once each)
function photo(img, id) {
  if (photoUrls[id]) { img.src = photoUrls[id]; return; }
  api("photo/" + id).then(function (r) { return r.ok ? r.blob() : null; }).then(function (b) {
    if (b) { photoUrls[id] = URL.createObjectURL(b); img.src = photoUrls[id]; }
  });
}

function hero(r) {
  var card = el("article", "hero"), img = el("img"), info = el("div", "info");
  img.alt = "Photo of the reported " + r.name; photo(img, r.id);
  info.append(el("span", "flag", "Invasive"), el("p", "species", r.name || niceName(r.species)));
  if (r.scientific && r.scientific !== r.name) info.append(el("span", "sci", r.scientific));
  var w = when(r.timestamp), facts = el("dl", "facts");
  [["Reported", w.ago + " · " + w.full], ["Confidence", Number(r.confidence).toFixed(1) + "%"], ["Model", r.model || "—"], ["Report", r.id]]
    .forEach(function (kv) { facts.append(el("dt", null, kv[0]), el("dd", null, kv[1])); });
  info.append(facts);
  if (Array.isArray(r.top3) && r.top3.length) {
    info.append(el("span", "eyebrow", "Model's top guesses"));
    var alts = el("div", "alts");
    r.top3.forEach(function (a) {
      var row = el("div", "alt"), track = el("div", "track"), fill = el("div", "fill");
      fill.style.width = Math.min(100, a.confidence) + "%"; track.append(fill);
      row.append(el("span", null, a.name || niceName(a.species)), track, el("span", "pct", Number(a.confidence).toFixed(0) + "%"));
      alts.append(row);
    });
    info.append(alts);
  }
  img.tabIndex = 0; img.title = "Show the whole photo";
  img.onclick = function () { openViewer(r); };
  img.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openViewer(r); } };
  card.append(img, info);
  return card;
}

function row(r) {
  var x = el("div", "row"), img = el("img"), what = el("div", "what");
  img.alt = ""; img.loading = "lazy"; photo(img, r.id);
  what.append(el("strong", null, r.name || niceName(r.species)), el("span", "muted", Number(r.confidence).toFixed(1) + "% confidence"));
  x.append(img, what, el("span", "when", when(r.timestamp).full));
  x.tabIndex = 0; x.setAttribute("role", "button"); x.title = "Show the whole photo";
  x.onclick = function () { openViewer(r); };
  x.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openViewer(r); } };
  return x;
}

var shownIds = "";
async function refresh() {
  var status = $("status");
  try {
    var res = await api("reports");
    if (res.status === 401) { showLogin("Wrong password."); return; }
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || ("Error " + res.status));
    $("login").hidden = true; $("logoutBox").hidden = false;
    var list = data.reports, ids = list.map(function (r) { return r.id; }).join();
    if (ids !== shownIds) {
      shownIds = ids;
      var box = $("latest"); box.innerHTML = "";
      if (!list.length) box.append(el("div", "empty", "No invasive insects have been reported yet. New reports appear here within seconds."));
      else box.append(hero(list[0]));
      var earlier = $("earlier"); earlier.innerHTML = "";
      list.slice(1).forEach(function (r) { earlier.append(row(r)); });
      $("earlierSection").hidden = list.length < 2;
      var counts = {};
      list.forEach(function (r) { var n = r.name || niceName(r.species); counts[n] = (counts[n] || 0) + 1; });
      var tally = $("tally"); tally.innerHTML = "";
      Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })
        .forEach(function (n) { tally.append(el("span", "chip", n + " × " + counts[n])); });
      $("tallyTitle").textContent = data.total > list.length ? "Species in the newest " + list.length + " reports" : "Species reported";
      $("tallySection").hidden = !list.length;
    }
    status.className = "status";
    status.textContent = data.total + " report" + (data.total === 1 ? "" : "s") + " · checked " +
      new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " · refreshes every 15 seconds";
  } catch (e) {
    status.className = "status error";
    status.textContent = e.message + " Retrying…";
  }
}

function showLogin(msg) {
  clearInterval(timer); timer = null;
  try { localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); } catch (e) {}
  password = null; shownIds = "";
  ["latest", "earlier", "tally"].forEach(function (id) { $(id).innerHTML = ""; });
  $("earlierSection").hidden = $("tallySection").hidden = $("logoutBox").hidden = true;
  $("login").hidden = false; $("loginMsg").textContent = msg || "";
  $("status").className = "status"; $("status").textContent = "Password needed";
  $("pw").focus();
}

function start() {
  refresh();
  if (!timer) timer = setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);
}

$("login").onsubmit = function (e) {
  e.preventDefault();
  password = $("pw").value; $("pw").value = "";
  try { ($("remember").checked ? localStorage : sessionStorage).setItem(KEY, password); } catch (e) {}
  start();
};
$("logout").onclick = function () { showLogin(""); };
document.addEventListener("visibilitychange", function () { if (!document.hidden && timer) refresh(); });

// Full, uncropped photo with the report's details; click anywhere or press Esc to close
var viewerReturn = null;
function openViewer(r) {
  viewerReturn = document.activeElement;
  var img = $("viewerImg");
  img.removeAttribute("src"); img.alt = "Photo of the reported " + (r.name || niceName(r.species));
  photo(img, r.id);
  var cap = $("viewerCaption"); cap.innerHTML = "";
  cap.append(el("strong", null, r.name || niceName(r.species)));
  if (r.scientific && r.scientific !== r.name) cap.append(el("em", null, r.scientific));
  var w = when(r.timestamp);
  cap.append(el("span", null, Number(r.confidence).toFixed(1) + "% · " + w.full + " · " + (r.model || "")));
  $("viewer").hidden = false;
  document.body.style.overflow = "hidden";
  $("viewerClose").focus();
}
function closeViewer() {
  if ($("viewer").hidden) return;
  $("viewer").hidden = true;
  document.body.style.overflow = "";
  if (viewerReturn && viewerReturn.focus) viewerReturn.focus();
}
$("viewer").onclick = closeViewer;
document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeViewer(); });

if (password) start(); else showLogin("");
</script>
</body>
</html>`;
