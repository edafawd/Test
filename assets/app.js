// The Pyinsect identifier app, shared by every model page (index.html = newest model,
// 2.7/index.html, ...). The page loads a model config first (assets/models/*.js), which sets
// window.PYINSECT_MODEL.
const MODEL = window.PYINSECT_MODEL;
const MODEL_NAME = MODEL.name;
const MODEL_URL = MODEL.url;
const CLASS_NAMES = MODEL.classes;
const INVASIVE = new Set(MODEL.invasive);
// How photos are fitted to 224×224 must match how the model was trained:
//   "squash": stretch the whole photo to 224×224 (transforms.Resize((224, 224)))
//   "crop":   shortest side → 256, then the centre 224×224
const RESIZE_MODE = MODEL.resize;
const EXT = /\.(jpe?g|png|bmp|webp|tiff?)$/i;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
const TOKEN_KEY = "pyinsect.token", PENDING_KEY = "pyinsect.pending", MINE_KEY = "pyinsect.mine";

const $ = id => document.getElementById(id);
let session = null, queue = Promise.resolve(), total = 0;

function setStatus(text, kind) {
  $("statusText").textContent = text;
  $("status").className = "status" + (kind ? " " + kind : "");
}
document.querySelector(".eyebrow").textContent = `${MODEL_NAME} · ${CLASS_NAMES.length} insect classes`;
const readyText = () => `${MODEL_NAME} ready · ${CLASS_NAMES.length} classes`;

// ---------- model ----------
async function loadModel() {
  try {
    if (typeof ort === "undefined") throw new Error("the onnxruntime script did not load. Check your internet connection.");
    ort.env.wasm.numThreads = 1;
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`could not download the model (${res.status})`);
    const size = Number(res.headers.get("content-length")) || MODEL.size;
    const reader = res.body.getReader(), chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      setStatus(`Loading model… ${Math.min(100, Math.round(got / size * 100))}%`, "busy");
    }
    const buf = new Uint8Array(got);
    let off = 0; for (const c of chunks) { buf.set(c, off); off += c.length; }
    setStatus("Starting model…", "busy");
    session = await ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
    setStatus(readyText(), "ready");
    $("pickPhotos").disabled = false; $("pickFolder").disabled = false; $("openCamera").disabled = false;
  } catch (e) {
    console.error(e);
    setStatus(`Model failed to load: ${e.message}`, "error");
  }
}

// Pillow's BILINEAR resize weights for one axis (antialiased when shrinking), so this
// page sees exactly the pixels main.py sees. Returns weights for outputs [from, from+count).
function pilCoeffs(inSize, outSize, from, count) {
  const scale = inSize / outSize, fscale = Math.max(scale, 1), support = fscale;
  const res = [];
  for (let o = from; o < from + count; o++) {
    const center = (o + 0.5) * scale;
    const min = Math.max(Math.trunc(center - support + 0.5), 0);
    const max = Math.min(Math.trunc(center + support + 0.5), inSize);
    const w = []; let sum = 0;
    for (let x = min; x < max; x++) {
      const t = Math.abs((x - center + 0.5) / fscale);
      const v = t < 1 ? 1 - t : 0; w.push(v); sum += v;
    }
    res.push({ min, w: w.map(v => v / sum) });
  }
  return res;
}

// Pillow-style bilinear resize (as above), ImageNet normalisation, CHW
function preprocess(bmp) {
  const { width: w, height: h } = bmp;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const src = ctx.getImageData(0, 0, w, h).data;

  let cx, cy;
  if (RESIZE_MODE === "squash") {
    cx = pilCoeffs(w, 224, 0, 224); cy = pilCoeffs(h, 224, 0, 224);
  } else {
    const [nw, nh] = w < h ? [256, Math.trunc(h * 256 / w)] : [Math.trunc(w * 256 / h), 256];
    const left = Math.trunc((nw - 224) / 2), top = Math.trunc((nh - 224) / 2);
    cx = pilCoeffs(w, nw, left, 224); cy = pilCoeffs(h, nh, top, 224);
  }

  // Horizontal pass (rounded to 8-bit like Pillow), only over the source rows the crop needs
  const y0 = cy[0].min, y1 = cy[223].min + cy[223].w.length;
  const mid = new Uint8ClampedArray((y1 - y0) * 224 * 3);
  for (let y = y0; y < y1; y++) {
    const row = y * w * 4, outRow = (y - y0) * 224 * 3;
    for (let x = 0; x < 224; x++) {
      const { min, w: k } = cx[x];
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < k.length; i++) {
        const p = row + (min + i) * 4;
        r += src[p] * k[i]; g += src[p + 1] * k[i]; b += src[p + 2] * k[i];
      }
      mid[outRow + x * 3] = Math.round(r); mid[outRow + x * 3 + 1] = Math.round(g); mid[outRow + x * 3 + 2] = Math.round(b);
    }
  }

  // Vertical pass, then normalise into CHW
  const out = new Float32Array(3 * 224 * 224), plane = 224 * 224;
  for (let y = 0; y < 224; y++) {
    const { min, w: k } = cy[y];
    for (let x = 0; x < 224; x++) {
      for (let ch = 0; ch < 3; ch++) {
        let v = 0;
        for (let i = 0; i < k.length; i++) v += mid[((min - y0 + i) * 224 + x) * 3 + ch] * k[i];
        v = Math.min(255, Math.max(0, Math.round(v)));
        out[ch * plane + y * 224 + x] = (v / 255 - MEAN[ch]) / STD[ch];
      }
    }
  }
  return new ort.Tensor("float32", out, [1, 3, 224, 224]);
}

function softmax(logits) {
  const m = Math.max(...logits);
  const e = logits.map(v => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map(v => v / s);
}

// ---------- reporting ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
store.del(TOKEN_KEY);   // tokens were only needed before the relay existed

function showReportState() {
  const pending = store.get(PENDING_KEY, []).length;
  const st = $("reportState");
  $("retryReports").hidden = !pending || !RELAY_URL;
  if (!RELAY_URL) { st.textContent = "off. The report server isn't set up yet."; st.className = "state warn"; return; }
  st.textContent = pending ? `on · ${pending} report(s) waiting to send` : "on · invasive finds are reported automatically";
  st.className = pending ? "state warn" : "state on";
}

// Reduced copy of the photo for the report (longest side 1024 px, JPEG)
function reportPhoto(bmp) {
  const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.8).split(",")[1];
}

function buildReport(bmp, species, confidence, top3) {
  const now = new Date(), pad = n => String(n).padStart(2, "0");
  const id = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}-${Math.random().toString(16).slice(2, 6)}`;
  const offset = -now.getTimezoneOffset(), sign = offset >= 0 ? "+" : "-";
  const local = new Date(now.getTime() + offset * 60000).toISOString().slice(0, 19)
    + `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return {
    report: {
      id, timestamp: local, species, name: commonName(species), ...(MODEL.scientific ? { scientific: sciName(species) } : {}),
      confidence: Math.round(confidence * 100) / 100,
      top3: top3.map(t => ({ species: t.species, name: commonName(t.species), confidence: Math.round(t.confidence * 100) / 100 })),
      photo: `${id}.jpg`, model: MODEL_NAME, app_version: "web-1.1",
    },
    photo: reportPhoto(bmp),
  };
}

let sending = null;
const dropPending = id => store.set(PENDING_KEY, store.get(PENDING_KEY, []).filter(p => p.report.id !== id));
const markReport = (id, text, cls) => {
  document.querySelectorAll(`[data-report="${id}"]`).forEach(e => { e.textContent = text; e.className = cls; });
  updateMine(id, { status: text, ok: cls.includes("ok") });
};

// Sends every waiting report to the relay, oldest first
function sendPending() {
  if (sending) return sending;
  sending = (async () => {
    let sent = 0, error = null;
    for (;;) {
      const list = store.get(PENDING_KEY, []);
      if (!list.length || !RELAY_URL) break;
      const { report, photo } = list[0];
      try {
        await relaySend(report, photo);
        dropPending(report.id);
        sent++;
        markReport(report.id, "Reported", "sent ok");
      } catch (e) {
        if (e.rejected) {   // would fail forever; drop it so later reports still go out
          dropPending(report.id);
          markReport(report.id, `Not reported: ${e.message}`, "sent bad");
          continue;
        }
        error = e.message;
        markReport(report.id, `Waiting to send: ${error}`, "sent bad");
        break;
      }
    }
    showReportState();
    return { sent, error };
  })().finally(() => { sending = null; });
  return sending;
}

function fileReport(bmp, species, confidence, top3, card) {
  const line = el("span", "sent", "");
  card.querySelector(".info").append(line);
  if (!RELAY_URL) { line.textContent = "Not reported: the report server isn't set up yet."; return; }
  const r = buildReport(bmp, species, confidence, top3);
  line.dataset.report = r.report.id;
  line.textContent = "Sending report…";
  addMine(r);
  const list = store.get(PENDING_KEY, []);
  list.push(r);
  if (!store.set(PENDING_KEY, list)) { markReport(r.report.id, "Not reported: this browser's storage is full.", "sent bad"); return; }
  sendPending();
}

// An AI-made photo is never reported; the card says why
function blockReport(card, ai) {
  const info = card.querySelector(".info");
  info.querySelector(".flag")?.after(el("span", "flag ai", "AI-generated photo"));
  info.append(el("span", "sent bad", "Not reported: this photo looks AI-generated. " + ai.reasons[0]));
}

// ---------- your reports (this tab) ----------
// Reports sent from this tab, newest first, kept in sessionStorage so they survive a reload.
const mine = {
  get() { try { return JSON.parse(sessionStorage.getItem(MINE_KEY)) || []; } catch { return []; } },
  set(list) {
    // Photos are the big part; if storage is full, drop the oldest photos first
    for (let keep = list.length; keep >= 0; keep--) {
      try { sessionStorage.setItem(MINE_KEY, JSON.stringify(list.map((m, i) => i < keep ? m : { ...m, photo: null }))); return; } catch {}
    }
  },
};

function addMine({ report, photo }) {
  const list = mine.get();
  list.unshift({ id: report.id, name: report.name, scientific: report.scientific || "", confidence: report.confidence,
    timestamp: report.timestamp, model: report.model, photo, status: "Sending report…", ok: false });
  mine.set(list.slice(0, 30));
  renderMine();
}

function updateMine(id, change) {
  const list = mine.get(), m = list.find(x => x.id === id);
  if (!m) return;
  Object.assign(m, change);
  mine.set(list);
  renderMine();
}

function renderMine() {
  const list = mine.get(), box = $("mine");
  $("mineSection").hidden = !list.length;
  $("mineCount").textContent = `${list.length} report${list.length === 1 ? "" : "s"}`;
  box.innerHTML = "";
  for (const m of list) {
    const row = el("div", "row"), img = el("img"), what = el("div", "what"), side = el("div", "when");
    img.alt = ""; if (m.photo) img.src = "data:image/jpeg;base64," + m.photo;
    what.append(el("strong", null, m.name), el("span", "muted", [m.scientific, `${Number(m.confidence).toFixed(1)}%`].filter(Boolean).join(" · ")));
    const t = new Date(m.timestamp);
    side.append(el("span", "state " + (m.ok ? "on" : /^Sending/.test(m.status) ? "" : "warn"), m.ok ? "Reported" : m.status),
      el("span", null, isNaN(t) ? "" : t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })));
    row.append(img, what, side);
    if (m.photo) {
      row.tabIndex = 0; row.setAttribute("role", "button"); row.title = "Show the whole photo";
      const open = () => openViewer(img.src, m.name, [m.scientific, `${Number(m.confidence).toFixed(1)}%`,
        isNaN(t) ? "" : t.toLocaleString(), m.ok ? "Reported" : m.status].filter(Boolean).join(" · "));
      row.onclick = open;
      row.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
    }
    box.append(row);
  }
}

// ---------- full-photo viewer ----------
let viewerReturn = null;
function openViewer(src, title, details) {
  viewerReturn = document.activeElement;
  $("viewerImg").src = src; $("viewerImg").alt = title;
  const cap = $("viewerCaption"); cap.innerHTML = "";
  cap.append(el("strong", null, title));
  if (details) cap.append(el("span", null, details));
  $("viewer").hidden = false;
  document.body.style.overflow = "hidden";
  $("viewerClose").focus();
}
function closeViewer() {
  if ($("viewer").hidden) return;
  $("viewer").hidden = true;
  document.body.style.overflow = "";
  viewerReturn?.focus?.();
}
$("viewer").onclick = closeViewer;
document.addEventListener("keydown", e => { if (e.key === "Escape") closeViewer(); });

// ---------- results ----------
function makeCard(file) {
  $("empty")?.remove();
  const card = el("article", "card pending");
  const img = el("img"); img.alt = ""; img.src = URL.createObjectURL(file);
  img.tabIndex = 0; img.title = "Show the whole photo";
  const open = () => openViewer(img.src, card.querySelector(".name").textContent,
    [card.querySelector(".sci")?.textContent, card.querySelector(".alt .pct")?.textContent, file.webkitRelativePath || file.name].filter(Boolean).join(" · "));
  img.onclick = open;
  img.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
  const info = el("div", "info");
  info.append(el("p", "name", "Analysing…"), el("span", "file", file.webkitRelativePath || file.name));
  card.append(img, info);
  $("cards").prepend(card);
  return card;
}

function fillCard(card, top3) {
  const best = top3[0], invasive = INVASIVE.has(best.species);
  card.className = "card" + (invasive ? " invasive" : "");
  const info = card.querySelector(".info"), fileLine = info.querySelector(".file");
  info.innerHTML = "";
  if (invasive) info.append(el("span", "flag", "Invasive"));
  const alts = el("div", "alts");
  for (const t of top3) {
    const row = el("div", "alt"), track = el("div", "track"), fill = el("div", "fill");
    fill.style.width = `${t.confidence.toFixed(1)}%`; track.append(fill);
    row.append(el("span", null, commonName(t.species)), track, el("span", "pct", `${t.confidence.toFixed(1)}%`));
    alts.append(row);
  }
  info.append(el("p", "name", commonName(best.species)), ...(MODEL.scientific ? [el("span", "sci", sciName(best.species))] : []), fileLine, alts);
  return invasive;
}

function classify(file) {
  total++;
  $("count").textContent = `${total} photo${total === 1 ? "" : "s"}`;
  const card = makeCard(file);
  queue = queue.then(async () => {
    try {
      setStatus(`Analysing ${file.name}…`, "busy");
      const bmp = await createImageBitmap(file);
      const out = await session.run({ [session.inputNames[0]]: preprocess(bmp) });
      const probs = softmax(Array.from(out[session.outputNames[0]].data));
      const top3 = [...probs.keys()].sort((a, b) => probs[b] - probs[a]).slice(0, 3)
        .map(i => ({ species: CLASS_NAMES[i] ?? `idx_${i}`, confidence: probs[i] * 100 }));
      if (fillCard(card, top3)) {
        // Photos from the in-page camera come straight from the camera; uploads are checked for AI labels
        const ai = file.fromCamera ? { verdict: "camera", reasons: [] } : await checkAI(file).catch(() => ({ verdict: "unknown", reasons: [] }));
        if (ai.verdict === "ai") blockReport(card, ai);
        else fileReport(bmp, top3[0].species, top3[0].confidence, top3, card);
      }
      bmp.close?.();
      setStatus(readyText(), "ready");
    } catch (e) {
      console.error(e);
      card.className = "card";
      card.querySelector(".name").textContent = "Couldn't read this image";
      setStatus(`${file.name}: ${e.message}`, "error");
    }
  });
}

function handleFiles(list) {
  if (!session) return;
  const files = [...list].filter(f => EXT.test(f.name)).sort((a, b) =>
    (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name));
  if (!files.length) { setStatus("No supported images found (jpg, png, bmp, webp).", "error"); return; }
  files.forEach(classify);
}

// ---------- camera ----------
// Live viewfinder in the page (getUserMedia). If the browser can't or won't share the camera,
// the phone's own camera app is offered instead (file input with capture).
let stream = null, facing = "environment";

function cameraMessage(text) {
  $("cameraMsg").textContent = text || "";
  $("cameraMsg").hidden = !text;
}

async function startCamera() {
  stopStream();
  $("shutter").disabled = true;
  cameraMessage("Starting camera…");
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    const video = $("cameraVideo");
    video.srcObject = stream;
    await video.play();
    video.classList.toggle("mirror", facing === "user");
    cameraMessage("");
    $("shutter").disabled = false;
    $("useCameraApp").hidden = true;
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
    $("switchCamera").hidden = cams.length < 2;
  } catch (e) {
    console.error(e);
    stopStream();
    cameraMessage(e && e.name === "NotAllowedError"
      ? "Camera access was blocked. Allow the camera for this site in your browser settings, or use your camera app instead."
      : e && e.name === "NotFoundError" ? "No camera found on this device."
      : "Couldn't start the camera here. You can use your camera app instead.");
    $("useCameraApp").hidden = false;
    $("switchCamera").hidden = true;
  }
}

function stopStream() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  $("cameraVideo").srcObject = null;
}

function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { $("captureInput").click(); return; }   // old browsers
  $("camera").hidden = false;
  $("camera").scrollIntoView({ behavior: "smooth", block: "start" });
  startCamera();
}

function closeCamera() {
  stopStream();
  $("camera").hidden = true;
}

// Grabs the current frame at the camera's full resolution as a JPEG file and identifies it
function takePhoto() {
  const video = $("cameraVideo");
  if (!stream || !video.videoWidth) return;
  const c = document.createElement("canvas");
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext("2d").drawImage(video, 0, 0);
  $("cameraFlash").classList.remove("go"); void $("cameraFlash").offsetWidth; $("cameraFlash").classList.add("go");
  c.toBlob(blob => {
    if (!blob) return;
    const d = new Date(), pad = n => String(n).padStart(2, "0");
    const name = `camera-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg`;
    closeCamera();
    const photo = new File([blob], name, { type: "image/jpeg" });
    photo.fromCamera = true;
    classify(photo);
    $("cards").scrollIntoView({ behavior: "smooth", block: "start" });
  }, "image/jpeg", 0.92);
}

$("openCamera").onclick = openCamera;
$("closeCamera").onclick = closeCamera;
$("shutter").onclick = takePhoto;
$("switchCamera").onclick = () => { facing = facing === "environment" ? "user" : "environment"; startCamera(); };
$("useCameraApp").onclick = () => { closeCamera(); $("captureInput").click(); };
$("captureInput").onchange = e => { handleFiles(e.target.files); e.target.value = ""; };
// Don't keep the camera running in a background tab
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopStream();
  else if (!$("camera").hidden && !stream) startCamera();
});

// ---------- wiring ----------
$("pickPhotos").onclick = () => $("photoInput").click();
$("pickFolder").onclick = () => $("folderInput").click();
$("photoInput").onchange = e => { handleFiles(e.target.files); e.target.value = ""; };
$("folderInput").onchange = e => { handleFiles(e.target.files); e.target.value = ""; };
const tray = $("tray");
["dragenter", "dragover"].forEach(t => tray.addEventListener(t, e => { e.preventDefault(); tray.classList.add("drag"); }));
["dragleave", "drop"].forEach(t => tray.addEventListener(t, e => { e.preventDefault(); tray.classList.remove("drag"); }));
tray.addEventListener("drop", e => handleFiles(e.dataTransfer.files));

$("retryReports").onclick = () => sendPending();
window.addEventListener("online", () => sendPending());

showReportState();
renderMine();
sendPending();
loadModel();
