// filmneg web UI. Talks to the local Python server; all image maths happens there.
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------------------------------------------------------------- state
const S = {
  doc: null,          // name, width, height, files, ...
  params: null,
  samples: [],        // {kind, x, y, r} in fractions of the full scan
  report: [],
  tool: "probe",
  curve: "colour",
  zoom: 0.04,         // magnified curve view shows ±zoom (encoded units)
  curveView: "classic", // "classic" (diagonal, Light and R/G/B) or "zoom" (the change, magnified)
  width: 0.12,        // soft-edit width on the tone axis (push tools and curves)
  probes: [],         // pinned probes: {at, res}
  colourCurve: "warmth", // which colour curve the Colour tab edits
  probeSel: null,     // which probe the detail table shows
  showSamples: true,  // eye toggles in the Samples and Measure panels
  showProbes: true,
  push: null,         // active push gesture (colour or light)
  undo: [], redo: [],
  levelCh: "rgb",     // which levels the Levels panel edits
  levelView: [0, 1],  // visible part of the Levels histogram (zoom)
  levelHist: null,    // {bins, hist: [r, g, b]} of the image before levels
  comparing: false,
  dragging: false,    // a slider/curve/push drag is in progress: render lighter previews
  view: { scale: 1, cx: 0.5, cy: 0.5 },  // zoom and the image point at the viewer's centre
  hist: null,         // histograms of the latest preview, for the curve panel
  mask: null,         // {kind: "push"|"clip", ...} overlay showing affected or clipped areas
};

// ---------------------------------------------------------------- server and busy indicator
let busyCount = 0;
function busy(delta) {
  busyCount = Math.max(0, busyCount + delta);
  const el = $("#busy"), on = busyCount > 0 || S.dragging;
  el.className = on ? "busy" : "idle";
  el.querySelector("span").textContent = on ? "Working…" : "Up to date";
}

async function api(route, body = {}) {
  busy(1);
  try {
    const res = await fetch("/api/" + route, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  } finally { busy(-1); }
}

async function fetchImage(body) {
  busy(1);
  try {
    const res = await fetch("/api/render", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    return await createImageBitmap(await res.blob(), { colorSpaceConversion: "default" });
  } finally { busy(-1); }
}

function status(msg, ms = 2500) {
  $("#status").textContent = msg;
  clearTimeout(status.t);
  if (ms) status.t = setTimeout(() => ($("#status").textContent = ""), ms);
}

async function guard(label, fn) {
  status(label + "…", 0);
  try { await fn(); status(label + " done"); }
  catch (e) { console.error(e); status(label + " failed: " + e.message, 8000); }
}

// ---------------------------------------------------------------- B-spline (mirrors curves.py)
const N_CTRL = 13, DEG = 3;
const KNOTS = (() => {
  const inner = [];
  for (let i = 1; i < N_CTRL - DEG; i++) inner.push(i / (N_CTRL - DEG));
  return [...Array(DEG + 1).fill(0), ...inner, ...Array(DEG + 1).fill(1)];
})();
const CTRL_POS = Array.from({ length: N_CTRL }, (_, i) =>
  (KNOTS[i + 1] + KNOTS[i + 2] + KNOTS[i + 3]) / 3);

function splineAt(ctrl, x) {
  x = Math.min(Math.max(x, 0), 1 - 1e-9);
  let k = DEG;
  while (k < KNOTS.length - DEG - 2 && x >= KNOTS[k + 1]) k++;
  const d = [];
  for (let j = 0; j <= DEG; j++) d.push(ctrl[j + k - DEG]);
  for (let r = 1; r <= DEG; r++) {
    for (let j = DEG; j >= r; j--) {
      const i = j + k - DEG;
      const a = (x - KNOTS[i]) / (KNOTS[i + DEG + 1 - r] - KNOTS[i]);
      d[j] = (1 - a) * d[j - 1] + a * d[j];
    }
  }
  return d[DEG];
}

function bump(center, amount, sigma) {
  return CTRL_POS.map((p) => amount * Math.exp(-0.5 * ((p - center) / sigma) ** 2));
}

const addTo = (ctrl, delta) => ctrl.map((v, i) => v + delta[i]);
const clone = (o) => JSON.parse(JSON.stringify(o));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function setWidth(w) {
  S.width = clamp(w, 0.03, 1.0);
  if (S.push) applyPush(false);
  drawCurve(); drawOverlay();
}

// ---------------------------------------------------------------- history
function snapshot() { return clone({ params: S.params, samples: S.samples }); }

function commit() {
  S.undo.push(S.lastCommitted);
  if (S.undo.length > 200) S.undo.shift();
  S.redo = [];
  S.lastCommitted = snapshot();
  scheduleSave();
  refreshReport();
  renderVersions();
}

function restore(snap) {
  S.params = clone(snap.params);
  S.samples = clone(snap.samples);
  S.lastCommitted = snapshot();
  syncControls(); render(); drawCurve(); drawOverlay(); refreshReport(); scheduleSave(); renderVersions();
}

// What changed between two snapshots, in words, for the undo/redo flash.
const PARAM_NAMES = {
  exposure: "Exposure", contrast: "Contrast", angle: "Rotation", distortion: "Lens distortion", shoulder: "Highlight roll-off", toe: "Shadow roll-off", saturation: "Saturation", nr: "Colour noise", lighting: "Light",
  crop: "Crop", levels: "Levels", black: "Auto levels", white: "Auto levels", slope: "Colour balance", offset: "Colour balance", mode: "Mode",
};
const CURVE_LABELS = { warmth: "Yellow/blue curve", tint: "Magenta/green curve", lightness: "Light curve", r: "Red curve", g: "Green curve", b: "Blue curve" };
function describeChange(a, b) {
  const out = new Set(), same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  if (!same(a.samples, b.samples)) out.add("Samples");
  for (const k of Object.keys(b.params)) {
    if (k === "curves") { for (const n in b.params.curves) if (!same(a.params.curves[n], b.params.curves[n])) out.add(CURVE_LABELS[n] || n); }
    else if (!same(a.params[k], b.params[k])) out.add(PARAM_NAMES[k] || k);
  }
  const list = [...out];
  return list.length > 2 ? list.slice(0, 2).join(", ") + " …" : list.join(", ") || "nothing";
}

function flash(kind, what) {
  const el = $("#flash");
  el.querySelector(".icon-undo").style.display = kind === "undo" ? "" : "none";
  el.querySelector(".icon-redo").style.display = kind === "redo" ? "" : "none";
  el.querySelector("span").textContent = ({ undo: "Undo: ", redo: "Redo: " }[kind] || "") + what;
  el.classList.remove("show"); void el.offsetWidth; el.classList.add("show");
}

function undo() {
  if (!S.undo.length) return flash("undo", "nothing left");
  const now = snapshot(), prev = S.undo.pop();
  S.redo.push(now); flash("undo", describeChange(prev, now)); restore(prev);
}
function redo() {
  if (!S.redo.length) return flash("redo", "nothing to redo");
  const now = snapshot(), next = S.redo.pop();
  S.undo.push(now); flash("redo", describeChange(now, next)); restore(next);
}

function scheduleSave() {
  clearTimeout(scheduleSave.t);
  scheduleSave.t = setTimeout(() => {
    api("save", { params: S.params, samples: S.samples, versions: S.versions || [], history: [] }).catch((e) => status("save failed: " + e.message));
  }, 800);
}

function startDrag() { S.dragging = true; busy(0); }
function endDrag() { if (S.dragging) { S.dragging = false; busy(0); render(); } }

// ---------------------------------------------------------------- rendering
const imgCanvas = $("#image"), overlay = $("#overlay");
let current = null;      // ImageBitmap of the latest render
let currentFull = false; // whether it shows the uncropped scan (crop tool)
let inflight = false, dirty = false;
let renderGen = 0;       // bumps whenever the edit changes; stale detail renders are dropped
let detail = null;       // {bmp, region, gen}: sharp full-resolution render of the zoomed-in area
let previewPx = null;    // {w, h, data}: small copy of the preview pixels for masks and histograms

function viewParams() {
  const p = clone(S.params);
  if (S.tool === "crop") p.crop = [0, 0, 1, 1];
  return p;
}

async function render() {
  renderGen++;
  if (liveReady()) { renderLive(); return; }
  if (inflight) { dirty = true; return; }
  inflight = true; dirty = false;
  const gen = renderGen;
  try {
    const full = S.tool === "crop";
    const bmp = await fetchImage({ params: viewParams(), original: S.comparing, size: S.dragging ? "drag" : "preview" });
    if (gen >= shownGen) {  // a newer live frame may already be on screen
      shownGen = gen;
      current = bmp; currentFull = full;
      showCurrent();
    }
    if (!S.dragging && !dirty && gen === renderGen) { scheduleDetail(); refreshProbes(); if (S.tool !== "crop") ensureSource(); }
  } catch (e) { status("render failed: " + e.message, 8000); }
  inflight = false;
  if (dirty) render();
}

function showCurrent() {
  readPreview();
  drawImage();
  drawCurve();
  scheduleLevelHist();
}

// ---------------------------------------------------------------- live preview
// While something is dragged, the browser applies the edit itself to a small 16-bit
// copy of the input (rotated, denoised and cropped by the server once). Per change it
// only fetches the per-channel stages as a 4096-entry table, so a frame is a lookup
// per pixel instead of rendering and sending a whole image. The full render replaces
// it when the drag ends.
let liveSrc = null;      // {key, w, h, data: Uint16Array}
let liveLoading = null;  // key being fetched
let liveBusy = false, liveDirty = false, shownGen = 0;
const liveCanvas = document.createElement("canvas");

function sourceKey(p) { return JSON.stringify([S.doc && S.doc.name, p.crop, p.angle, p.distortion, p.nr]); }

function liveReady() {
  return S.dragging && !S.comparing && S.tool !== "crop" && liveSrc && liveSrc.key === sourceKey(S.params);
}

async function ensureSource() {
  const key = sourceKey(S.params);
  if ((liveSrc && liveSrc.key === key) || liveLoading === key) return;
  liveLoading = key;
  try {
    const src = await fetchRGB16("source", S.params);
    if (liveLoading === key) liveSrc = { key, ...src };
  } catch (e) { console.error(e); }
  if (liveLoading === key) liveLoading = null;
}

async function renderLive() {
  if (liveBusy) { liveDirty = true; return; }
  liveBusy = true; liveDirty = false;
  const gen = renderGen;
  try {
    const lut = await api("lut", { params: S.params });
    if (liveReady() && gen >= shownGen) {
      shownGen = gen;
      paintLive(lut);
      current = liveCanvas; currentFull = false;
      showCurrent();
    }
  } catch (e) { console.error(e); }
  liveBusy = false;
  if (liveDirty && liveReady()) renderLive();
}

const f32 = (b64) => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return new Float32Array(u.buffer); };
const SRGB_ENC = (() => {  // linear 0..1 in 65536 steps -> sRGB 8-bit
  const t = new Uint8ClampedArray(65536);
  for (let i = 0; i < 65536; i++) { const v = i / 65535; t[i] = 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) + 0.5; }
  return t;
})();

// The same steps as pipeline.render_pixels after the per-channel table, then on to sRGB.
function paintLive(lut) {
  const { w, h, data } = liveSrc, n = lut.n, T = f32(lut.table), Sh = f32(lut.shifts), sp = lut.space;
  const N1 = n - 1, sat = S.params.saturation, toS = sp.to_srgb.flat();
  const dec = new Float32Array(n);  // encoded (scan space) -> linear
  for (let i = 0; i < n; i++) { const v = i / N1; dec[i] = sp.gamma ? v ** sp.gamma : v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
  const A = sp.lin_to_lms.flat(), B = sp.m2.flat(), Bi = sp.m2_inv.flat(), Ai = sp.lms_to_lin.flat();
  liveCanvas.width = w; liveCanvas.height = h;
  const ctx = liveCanvas.getContext("2d"), im = ctx.createImageData(w, h), o = im.data;
  const q = (v) => (v <= 0 ? 0 : v >= 1 ? N1 : (v * N1 + 0.5) | 0);
  for (let p = 0, j = 0; p < data.length; p += 3, j += 4) {
    let r = T[(data[p] >> 4) * 3], g = T[(data[p + 1] >> 4) * 3 + 1], b = T[(data[p + 2] >> 4) * 3 + 2];
    const t = q(0.2126 * r + 0.7152 * g + 0.0722 * b), wm = Sh[t * 2], m = Sh[t * 2 + 1];
    r += wm / 2 + m / 3; g -= 2 * m / 3; b += -wm / 2 + m / 3;
    r = dec[q(r)]; g = dec[q(g)]; b = dec[q(b)];
    if (sat !== 1) {  // Oklab chroma scale, then back to the scan's encoding and linear again
      let l = Math.cbrt(A[0] * r + A[1] * g + A[2] * b), mm = Math.cbrt(A[3] * r + A[4] * g + A[5] * b), s_ = Math.cbrt(A[6] * r + A[7] * g + A[8] * b);
      const L = B[0] * l + B[1] * mm + B[2] * s_, a = (B[3] * l + B[4] * mm + B[5] * s_) * sat, bb = (B[6] * l + B[7] * mm + B[8] * s_) * sat;
      l = (Bi[0] * L + Bi[1] * a + Bi[2] * bb) ** 3; mm = (Bi[3] * L + Bi[4] * a + Bi[5] * bb) ** 3; s_ = (Bi[6] * L + Bi[7] * a + Bi[8] * bb) ** 3;
      r = Ai[0] * l + Ai[1] * mm + Ai[2] * s_; g = Ai[3] * l + Ai[4] * mm + Ai[5] * s_; b = Ai[6] * l + Ai[7] * mm + Ai[8] * s_;
      r = Math.min(1, Math.max(0, r)); g = Math.min(1, Math.max(0, g)); b = Math.min(1, Math.max(0, b));  // clipped in encoded space too
    }
    const R = toS[0] * r + toS[1] * g + toS[2] * b, G = toS[3] * r + toS[4] * g + toS[5] * b, Bl = toS[6] * r + toS[7] * g + toS[8] * b;
    o[j] = SRGB_ENC[R <= 0 ? 0 : R >= 1 ? 65535 : (R * 65535) | 0];
    o[j + 1] = SRGB_ENC[G <= 0 ? 0 : G >= 1 ? 65535 : (G * 65535) | 0];
    o[j + 2] = SRGB_ENC[Bl <= 0 ? 0 : Bl >= 1 ? 65535 : (Bl * 65535) | 0];
    o[j + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);
}

// Zoomed in: fetch the visible part from full resolution so it stays sharp.
function scheduleDetail() {
  clearTimeout(scheduleDetail.t);
  scheduleDetail.t = setTimeout(async () => {
    if (!current || S.view.scale < 1.3 || S.dragging || S.comparing) return;
    const W = imgCanvas.clientWidth, H = imgCanvas.clientHeight, r = fitRect();
    const region = [clamp(-r.x / r.w, 0, 1), clamp(-r.y / r.h, 0, 1), clamp((W - r.x) / r.w, 0, 1), clamp((H - r.y) / r.h, 0, 1)];
    const gen = renderGen;
    try {
      const bmp = await fetchImage({ params: viewParams(), region });
      if (gen === renderGen) { detail = { bmp, region, gen }; drawImage(); }
    } catch (e) { console.error(e); }
  }, 180);
}

function readPreview() {
  const w = Math.min(600, current.width), h = Math.max(1, Math.round(current.height * w / current.width));
  const c = readPreview.c || (readPreview.c = document.createElement("canvas"));
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(current, 0, 0, w, h);
  previewPx = { w, h, data: ctx.getImageData(0, 0, w, h).data };
  // histograms for the curve panel: luma and the three channels
  const B = 128, hist = { lightness: new Float32Array(B), r: new Float32Array(B), g: new Float32Array(B), b: new Float32Array(B) };
  const d = previewPx.data;
  for (let i = 0; i < d.length; i += 4) {
    const t = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    hist.lightness[Math.min(B - 1, t * B / 256 | 0)]++;
    hist.r[d[i] * B >> 8]++; hist.g[d[i + 1] * B >> 8]++; hist.b[d[i + 2] * B >> 8]++;
  }
  S.hist = hist;
  S.maskCache = null;
}

function baseFit() {
  const W = imgCanvas.clientWidth, H = imgCanvas.clientHeight;
  return Math.min(W / current.width, H / current.height) * 0.96;
}

function fitRect() {
  const W = imgCanvas.clientWidth, H = imgCanvas.clientHeight;
  if (!current) return { x: 0, y: 0, w: W, h: H };
  const s = baseFit() * S.view.scale;
  const w = current.width * s, h = current.height * s;
  return { x: W / 2 - S.view.cx * w, y: H / 2 - S.view.cy * h, w, h };
}

function clampView() {
  if (!current) return;
  const W = imgCanvas.clientWidth, H = imgCanvas.clientHeight, s = baseFit() * S.view.scale;
  const w = current.width * s, h = current.height * s;
  S.view.cx = w <= W ? 0.5 : clamp(S.view.cx, W / 2 / w, 1 - W / 2 / w);
  S.view.cy = h <= H ? 0.5 : clamp(S.view.cy, H / 2 / h, 1 - H / 2 / h);
}

function zoomAt(mx, my, factor) {
  if (!current) return;
  const r = fitRect(), u = (mx - r.x) / r.w, v = (my - r.y) / r.h;
  S.view.scale = clamp(S.view.scale * factor, 1, 24);
  const s = baseFit() * S.view.scale, w = current.width * s, h = current.height * s;
  const W = imgCanvas.clientWidth, H = imgCanvas.clientHeight;
  S.view.cx = (W / 2 - (mx - u * w)) / w;
  S.view.cy = (H / 2 - (my - v * h)) / h;
  clampView(); detail = null; drawImage(); scheduleDetail();
}

function fitView() { S.view = { scale: 1, cx: 0.5, cy: 0.5 }; detail = null; drawImage(); }

function sizeCanvases() {
  const dpr = window.devicePixelRatio || 1;
  for (const c of [imgCanvas, overlay]) {
    c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
    c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

function drawImage() {
  const ctx = imgCanvas.getContext("2d");
  ctx.clearRect(0, 0, imgCanvas.clientWidth, imgCanvas.clientHeight);
  if (!current) return;
  const r = fitRect();
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(current, r.x, r.y, r.w, r.h);
  if (detail && detail.gen === renderGen && S.view.scale >= 1.3 && !S.comparing) {
    const [u0, v0, u1, v1] = detail.region;
    ctx.drawImage(detail.bmp, r.x + u0 * r.w, r.y + v0 * r.h, (u1 - u0) * r.w, (v1 - v0) * r.h);
  }
  drawOverlay();
}

// Shown box (in full-scan fractions) and conversions to/from screen points.
function shownBox() { return currentFull ? [0, 0, 1, 1] : S.params.crop; }

function toScan(ev) {
  const b = overlay.getBoundingClientRect(), r = fitRect(), c = shownBox();
  const u = (ev.clientX - b.left - r.x) / r.w, v = (ev.clientY - b.top - r.y) / r.h;
  return { x: c[0] + u * (c[2] - c[0]), y: c[1] + v * (c[3] - c[1]), u, v, inside: u >= 0 && u <= 1 && v >= 0 && v <= 1 };
}

function toScreen(x, y) {
  const r = fitRect(), c = shownBox();
  return { x: r.x + (x - c[0]) / (c[2] - c[0]) * r.w, y: r.y + (y - c[1]) / (c[3] - c[1]) * r.h };
}

function radiusPx(rFrac) {
  const r = fitRect(), c = shownBox(), W = S.doc.width, H = S.doc.height;
  return rFrac * Math.max(W, H) * r.w / ((c[2] - c[0]) * W);
}

// Browser-side tone (luma, 0..1) of the preview at image fractions u, v.
function previewTone(u, v) {
  if (!previewPx) return null;
  const x = clamp(Math.floor(u * previewPx.w), 0, previewPx.w - 1), y = clamp(Math.floor(v * previewPx.h), 0, previewPx.h - 1);
  const i = (y * previewPx.w + x) * 4, d = previewPx.data;
  return (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
}

// ---------------------------------------------------------------- overlay
const KIND_COLOR = { neutral: "#9ad", white: "#fff", black: "#000", skin: "#e9a37a" };

// A canvas the size of previewPx that dims what a push leaves alone, or the clipping overlay.
function maskCanvas() {
  if (S.mask && S.mask.kind === "clip") return clipCanvas();
  if (!S.mask || !previewPx) return null;
  const key = JSON.stringify(S.mask) + previewPx.w;
  if (S.maskCache && S.maskCache.key === key) return S.maskCache.canvas;
  const { w, h, data } = previewPx;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d"), im = ctx.createImageData(w, h), o = im.data;
  for (let i = 0; i < data.length; i += 4) {
    const t = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    const wgt = Math.exp(-0.5 * ((t - S.mask.tone) / S.mask.width) ** 2);
    o[i] = o[i + 1] = o[i + 2] = 0; o[i + 3] = (1 - wgt) * 70;  // light shade over what stays untouched
  }
  ctx.putImageData(im, 0, 0);
  S.maskCache = { key, canvas: c };
  return c;
}

function drawOverlay() {
  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, overlay.clientWidth, overlay.clientHeight);
  if (!S.doc || !current) return;

  if (S.tool === "crop") {
    const c = S.cropDrag || S.params.crop;
    const a = toScreen(c[0], c[1]), b = toScreen(c[2], c[3]), r = fitRect();
    ctx.fillStyle = "rgba(0,0,0,.5)";  // one even-odd path, so the veil has no seams
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.fill("evenodd");
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    // handles: corners and edge midpoints
    ctx.lineWidth = 3; ctx.beginPath();
    const L = Math.min(18, (b.x - a.x) / 4, (b.y - a.y) / 4), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    for (const [x, y, sx, sy] of [[a.x, a.y, 1, 1], [b.x, a.y, -1, 1], [b.x, b.y, -1, -1], [a.x, b.y, 1, -1]]) {
      ctx.moveTo(x, y + sy * L); ctx.lineTo(x, y); ctx.lineTo(x + sx * L, y);
    }
    ctx.moveTo(mx - L / 2, a.y); ctx.lineTo(mx + L / 2, a.y); ctx.moveTo(mx - L / 2, b.y); ctx.lineTo(mx + L / 2, b.y);
    ctx.moveTo(a.x, my - L / 2); ctx.lineTo(a.x, my + L / 2); ctx.moveTo(b.x, my - L / 2); ctx.lineTo(b.x, my + L / 2);
    ctx.stroke(); ctx.lineWidth = 1;
    // thirds, and a finer grid while rotating, to judge what is level
    const n = S.rotating ? 12 : 3;
    ctx.strokeStyle = S.rotating ? "rgba(255,255,255,.28)" : "rgba(255,255,255,.4)"; ctx.beginPath();
    for (let i = 1; i < n; i++) {
      const x = a.x + (b.x - a.x) * i / n, y = a.y + (b.y - a.y) * i / n;
      ctx.moveTo(x, a.y); ctx.lineTo(x, b.y); ctx.moveTo(a.x, y); ctx.lineTo(b.x, y);
    }
    ctx.stroke();
    if (S.levelLine) {
      const L = S.levelLine;
      for (const [c, w] of [["rgba(0,0,0,.8)", 4], ["#ffd23c", 2]]) {
        ctx.strokeStyle = c; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(L.x0, L.y0); ctx.lineTo(L.x1, L.y1); ctx.stroke();
      }
    }
    return;
  }

  const m = maskCanvas();
  if (m) {
    const r = fitRect();
    ctx.save(); ctx.imageSmoothingQuality = "high";
    if (S.mask.kind === "clip") ctx.filter = "blur(0.8px)";  // keeps grain from turning into speckles
    ctx.drawImage(m, r.x, r.y, r.w, r.h); ctx.restore();
  }

  if (S.showSamples) S.samples.forEach((s, i) => drawSample(ctx, s, KIND_COLOR[s.kind], String(i + 1)));
  if (S.showProbes) S.probes.forEach((p, i) => drawMeasure(ctx, p.at, PROBE_COLORS[i % PROBE_COLORS.length], "P" + (i + 1)));
  if (S.hl) drawHighlight(ctx);
  if (S.brush) S.brush.kind ? drawSample(ctx, S.brush, KIND_COLOR[S.brush.kind], S.brush.label) : drawMeasure(ctx, S.brush, "#fff", "");

  if (S.push) S.push.kind === "light" ? drawLightBar(ctx) : drawWheel(ctx);
}

// ---- highlighting and deleting marks on the image
// S.hl = {type: "sample"|"probe", i}: the mark under the mouse, or whose row in
// the sidebar the mouse is over. It gets a halo and a small × to delete it.
function markOf(hl) {
  const m = hl.type === "sample" ? S.samples[hl.i] : S.probes[hl.i]?.at;
  if (!m) return null;
  const p = toScreen(m.x, m.y), rad = radiusPx(m.r || 0);
  const d = Math.max(rad, 10) * 0.72;
  return { p, rad, del: { x: p.x - d - 10, y: p.y - d - 10 } };
}

function drawHighlight(ctx) {
  const m = markOf(S.hl);
  if (!m) return;
  const r = Math.max(m.rad, 9) + 5;
  ctx.save();
  ctx.strokeStyle = "rgba(255,210,60,.95)"; ctx.lineWidth = 3; ctx.shadowColor = "rgba(0,0,0,.8)"; ctx.shadowBlur = 6;
  ctx.beginPath(); ctx.arc(m.p.x, m.p.y, r, 0, 7); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#d33"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(m.del.x, m.del.y, 8, 0, 7); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(m.del.x - 3, m.del.y - 3); ctx.lineTo(m.del.x + 3, m.del.y + 3);
  ctx.moveTo(m.del.x + 3, m.del.y - 3); ctx.lineTo(m.del.x - 3, m.del.y + 3); ctx.stroke();
  ctx.restore();
}

// Which visible mark is under screen point (x, y), if any.
function markAt(x, y) {
  const near = (m) => m && Math.hypot(m.p.x - x, m.p.y - y) < Math.max(m.rad, 9);
  if (S.showProbes) for (let i = S.probes.length - 1; i >= 0; i--) if (near(markOf({ type: "probe", i }))) return { type: "probe", i };
  if (S.showSamples) for (let i = S.samples.length - 1; i >= 0; i--) if (near(markOf({ type: "sample", i }))) return { type: "sample", i };
  return null;
}

function setHighlight(hl) {
  const same = (a, b) => (a && b ? a.type === b.type && a.i === b.i : a === b);
  if (same(hl, S.hl)) return;
  S.hl = hl;
  $$("#samples li, #probe-list li").forEach((li) => li.classList.toggle("hl", !!hl && li.dataset.type === hl.type && +li.dataset.i === hl.i));
  drawOverlay();
}

function deleteMark(hl) {
  if (hl.type === "sample") { S.samples.splice(hl.i, 1); renderSamples(); commit(); }
  else { S.probes.splice(hl.i, 1); S.probeSel = null; showProbe(); drawCurve(); }
  S.hl = null; drawOverlay();
}

// Samples are round: a circle for an area, a dot for a point, with a numbered badge
// in the sample's colour.
function drawSample(ctx, s, color, label) {
  const p = toScreen(s.x, s.y), rad = radiusPx(s.r || 0), outline = color === "#000" ? "#fff" : "#000";
  ctx.save();
  if (rad < 4) {
    ctx.fillStyle = color; ctx.strokeStyle = outline; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(p.x, p.y, 4.5, 0, 7); ctx.fill(); ctx.stroke();
  } else {
    for (const [c, w] of [[outline, 3.5], [color, 1.6]]) {
      ctx.strokeStyle = c; ctx.lineWidth = w; ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 7); ctx.stroke();
    }
  }
  if (label) {
    const d = Math.max(rad, 5) * 0.72, bx = p.x + d + 7, by = p.y - d - 7;
    ctx.fillStyle = color; ctx.strokeStyle = outline; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(bx, by, 7, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = outline; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(label, bx, by + 0.5);
  }
  ctx.restore();
}

// Measured points are square: a crosshair with an open centre for a point,
// corner brackets for an area, and a plain coloured label.
function drawMeasure(ctx, s, color, label) {
  const p = toScreen(s.x, s.y), rad = radiusPx(s.r || 0);
  ctx.save();
  const path = () => {
    ctx.beginPath();
    if (rad < 4) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(p.x + dx * 3, p.y + dy * 3); ctx.lineTo(p.x + dx * 10, p.y + dy * 10); }
    } else {
      const k = Math.min(rad * 0.45, 12);
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const cx = p.x + sx * rad, cy = p.y + sy * rad;
        ctx.moveTo(cx, cy - sy * k); ctx.lineTo(cx, cy); ctx.lineTo(cx - sx * k, cy);
      }
    }
  };
  for (const [c, w] of [["rgba(0,0,0,.85)", 4], [color, 2]]) { ctx.strokeStyle = c; ctx.lineWidth = w; path(); ctx.stroke(); }
  if (label) {
    const d = Math.max(rad, 10);
    ctx.font = "bold 11px sans-serif"; ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,.85)"; ctx.fillStyle = color;
    ctx.strokeText(label, p.x + d + 3, p.y - d + 2); ctx.fillText(label, p.x + d + 3, p.y - d + 2);
  }
  ctx.restore();
}

// Colour wheel for the push tool. Right = magenta, up = yellow, left = green, down = blue.
function drawWheel(ctx) {
  const { sx, sy, cx, cy } = S.push, R = 70;
  ctx.save();
  if (ctx.createConicGradient) {
    const g = ctx.createConicGradient(0, sx, sy);
    [[0, "#e040c0"], [0.125, "#8050f0"], [0.25, "#3070ff"], [0.375, "#20c0d0"],
     [0.5, "#30c040"], [0.625, "#a0d020"], [0.75, "#ffd020"], [0.875, "#ff7030"], [1, "#e040c0"]]
      .forEach(([o, c]) => g.addColorStop(o, c));
    ctx.strokeStyle = g;
  } else ctx.strokeStyle = "#fff";
  ctx.lineWidth = 8; ctx.globalAlpha = 0.85;
  ctx.beginPath(); ctx.arc(sx, sy, R, 0, 7); ctx.stroke();
  ctx.globalAlpha = 1; ctx.lineWidth = 1; ctx.strokeStyle = "rgba(255,255,255,.6)";
  ctx.beginPath(); ctx.arc(sx, sy, R * 0.5, 0, 7); ctx.stroke();
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(cx, cy); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, 4, 0, 7); ctx.fillStyle = "#fff"; ctx.fill();
  ctx.restore();
}

function drawLightBar(ctx) {
  const { sx, sy, cy } = S.push, H = 70;
  ctx.save();
  const g = ctx.createLinearGradient(0, sy - H, 0, sy + H);
  g.addColorStop(0, "#fff"); g.addColorStop(1, "#000");
  ctx.fillStyle = g; ctx.strokeStyle = "rgba(255,255,255,.7)";
  ctx.fillRect(sx - 5, sy - H, 10, 2 * H); ctx.strokeRect(sx - 5, sy - H, 10, 2 * H);
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(sx + 12, sy); ctx.lineTo(sx + 12, cy); ctx.stroke();
  ctx.beginPath(); ctx.arc(sx + 12, cy, 4, 0, 7); ctx.fillStyle = "#fff"; ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------- image interaction
const PUSH_GAIN = 0.03;     // curve delta at 150 px drag
const PUSH_CURVE = 1.6;     // >1: very gentle near the centre, stronger further out

function pushStrength(d, fine) {
  return d < 2 ? 0 : PUSH_GAIN * Math.pow(d / 150, PUSH_CURVE) * (fine ? 0.25 : 1);
}

overlay.addEventListener("mousedown", async (ev) => {
  if (!S.doc || ev.button !== 0) return;  // right button opens the menu
  const p = toScan(ev);
  const tool = S.tool;
  if (S.hl) {  // the × next to a highlighted mark
    const m = markOf(S.hl);
    if (m && Math.hypot(m.del.x - ev.offsetX, m.del.y - ev.offsetY) < 10) { deleteMark(S.hl); return; }
    if (tool !== "crop" && S.hl && !ev.shiftKey) {  // grab a mark to move it, whatever the tool
      const probe = S.hl.type === "probe", t = probe ? S.probes[S.hl.i].at : S.samples[S.hl.i];
      if (probe) { S.probeSel = S.hl.i; showProbe(); }
      S.sampleMove = { probe, i: S.hl.i, sx: ev.clientX, sy: ev.clientY, x: t.x, y: t.y, moved: false };
      return;
    }
  }

  if (tool === "crop") {
    if (S.leveling) { S.levelLine = { x0: ev.offsetX, y0: ev.offsetY, x1: ev.offsetX, y1: ev.offsetY }; return; }
    if (!p.inside) {  // outside the picture: drag around it to rotate
      const r = fitRect(), cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      S.rotDrag = { cx, cy, a0: Math.atan2(ev.offsetY - cy, ev.offsetX - cx), angle0: S.params.angle };
      S.rotating = true; startDrag(); return;
    }
    const hit = cropHit(ev.offsetX, ev.offsetY), c = S.params.crop;
    if (hit && hit.corner) S.cropStart = { mode: "corner", ax: hit.ax, ay: hit.ay };
    else if (hit && hit.edge) S.cropStart = { mode: "edge", edge: hit.edge, c0: [...c] };
    else if (hit && hit.inside) S.cropStart = ev.shiftKey ? { mode: "corner", ax: p.x, ay: p.y } : { mode: "move", x: p.x, y: p.y, c0: [...c] };
    else if (ev.shiftKey) S.cropStart = { mode: "corner", ax: p.x, ay: p.y };  // ⇧-drag: a new crop
    else {
      // outside the crop: the nearest edge (or corner, if beyond two edges) jumps to the pointer
      const ex = p.x < c[0] ? 0 : p.x > c[2] ? 2 : null, ey = p.y < c[1] ? 1 : p.y > c[3] ? 3 : null;
      if (ex !== null && ey !== null) S.cropStart = { mode: "corner", ax: c[2 - ex], ay: c[4 - ey] };
      else S.cropStart = { mode: "edge", edge: ex ?? ey, c0: [...c] };
    }
    S.cropDrag = [...c];
    if (S.cropStart.mode !== "move") { mousemoveCrop(p); drawOverlay(); }
    return;
  }
  if (!p.inside) {
    if (S.view.scale > 1) S.pan = { x: ev.clientX, y: ev.clientY, cx: S.view.cx, cy: S.view.cy };
    return;
  }

  if (["neutral", "white", "black", "skin", "probe"].includes(tool)) {
    if (tool === "probe") {
      const hit = S.probes.findIndex((q) => Math.hypot(toScreen(q.at.x, q.at.y).x - ev.offsetX, toScreen(q.at.x, q.at.y).y - ev.offsetY) < Math.max(radiusPx(q.at.r || 0), 8));
      if (hit >= 0 && ev.shiftKey) { S.probes.splice(hit, 1); S.probeSel = null; showProbe(); drawOverlay(); drawCurve(); return; }
      if (hit >= 0) { S.probeSel = hit; S.sampleMove = { probe: true, i: hit, sx: ev.clientX, sy: ev.clientY, x: S.probes[hit].at.x, y: S.probes[hit].at.y, moved: false }; showProbe(); return; }
    }
    if (tool !== "probe") {
      const hit = S.samples.findIndex((s) => Math.hypot(toScreen(s.x, s.y).x - ev.offsetX, toScreen(s.x, s.y).y - ev.offsetY) < Math.max(radiusPx(s.r || 0), 8));
      if (hit >= 0 && ev.shiftKey) { S.samples.splice(hit, 1); drawOverlay(); renderSamples(); commit(); return; }
      if (hit >= 0) { S.sampleMove = { i: hit, sx: ev.clientX, sy: ev.clientY, x: S.samples[hit].x, y: S.samples[hit].y, moved: false }; return; }
    }
    // a click takes one point; dragging grows a circle from the click
    S.brush = { kind: tool === "probe" ? null : tool, x: p.x, y: p.y, r: 0, sx: ev.clientX, sy: ev.clientY,
                label: tool === "probe" ? "" : String(S.samples.length + 1) };
    drawOverlay();
    return;
  }

  if (tool === "push" || tool === "light") {
    const at = { x: p.x, y: p.y, r: 0.006 };
    S.push = { kind: tool === "light" ? "light" : "colour", sx: ev.offsetX, sy: ev.offsetY, cx: ev.offsetX, cy: ev.offsetY,
               tone: null, base: clone(S.params.curves) };
    const bt = previewTone(p.u, p.v);
    if (bt != null) S.mask = { kind: "push", tone: bt, width: S.width };
    startDrag(); drawOverlay();
    if (tool === "light") setCurve("lightness"); else setCurve("colour");
    const pr = await api("probe", { params: S.params, at });
    if (S.push) { S.push.tone = pr.tone; applyPush(ev.altKey); }
  }
});

overlay.addEventListener("mousemove", (ev) => {
  if (S.brush || S.sampleMove || S.push || S.cropStart || S.pan || S.rotDrag || ev.buttons) return;
  if (S.tool === "crop") {
    const hit = !S.leveling && cropHit(ev.offsetX, ev.offsetY);
    const p = toScan(ev), c = S.params.crop;
    const ex = p.x < c[0] || p.x > c[2], ey = p.y < c[1] || p.y > c[3];
    const outside = ex && ey ? ((p.x < c[0]) === (p.y < c[1]) ? "nwse-resize" : "nesw-resize") : ex ? "ew-resize" : "ns-resize";
    overlay.style.cursor = S.leveling ? "crosshair" : hit ? hit.cursor : p.inside ? outside : ROTATE_CURSOR;
    return;
  }
  const m = S.hl && markOf(S.hl), onDel = m && Math.hypot(m.del.x - ev.offsetX, m.del.y - ev.offsetY) < 10;
  if (!onDel) setHighlight(markAt(ev.offsetX, ev.offsetY));
  overlay.style.cursor = onDel ? "pointer" : S.hl ? "move" : S.tool === "push" ? "move" : S.tool === "light" ? "ns-resize" : "crosshair";
});
overlay.addEventListener("mouseleave", () => { if (!S.sampleMove) setHighlight(null); });

window.addEventListener("mousemove", (ev) => {
  if (S.rotDrag) {
    const b = overlay.getBoundingClientRect(), R = S.rotDrag;
    const a = Math.atan2(ev.clientY - b.top - R.cy, ev.clientX - b.left - R.cx);
    let d = (a - R.a0) * 180 / Math.PI;
    d = ((d + 540) % 360) - 180;
    setGeom("angle", R.angle0 - d * (ev.altKey ? 0.2 : 1));
    drawOverlay(); return;
  }
  if (S.levelLine) {
    const b = overlay.getBoundingClientRect();
    S.levelLine.x1 = ev.clientX - b.left; S.levelLine.y1 = ev.clientY - b.top;
    const L = S.levelLine, th = Math.atan2(-(L.y1 - L.y0), L.x1 - L.x0) * 180 / Math.PI;
    hint(`rotate by ${fmt(-(th - Math.round(th / 90) * 90), 2)}° to make this line ${Math.abs(Math.round(th / 90)) % 2 ? "upright" : "level"}`);
    drawOverlay(); return;
  }
  if (S.cropStart) {
    mousemoveCrop(toScan(ev)); drawOverlay(); return;
  }
  if (S.brush) {
    const d = Math.hypot(ev.clientX - S.brush.sx, ev.clientY - S.brush.sy);
    S.brush.r = d < 4 ? 0 : d / radiusPx(1);
    hint(S.brush.r ? `area ${Math.round(d)} px` : "");
    drawOverlay(); return;
  }
  if (S.sampleMove) {
    const M = S.sampleMove, r = fitRect(), c = shownBox();
    M.moved = true;
    const target = M.probe ? S.probes[M.i].at : S.samples[M.i];
    target.x = M.x + (ev.clientX - M.sx) / r.w * (c[2] - c[0]);
    target.y = M.y + (ev.clientY - M.sy) / r.h * (c[3] - c[1]);
    drawOverlay(); return;
  }
  if (S.pan) {
    const r = fitRect();
    S.view.cx = S.pan.cx - (ev.clientX - S.pan.x) / r.w;
    S.view.cy = S.pan.cy - (ev.clientY - S.pan.y) / r.h;
    clampView(); drawImage(); return;
  }
  if (S.push) {
    const b = overlay.getBoundingClientRect();
    S.push.cx = ev.clientX - b.left; S.push.cy = ev.clientY - b.top;
    // the shade shows what the press reaches; it goes once you move, so the colour reads true
    if (S.mask && S.mask.kind === "push" && Math.hypot(S.push.cx - S.push.sx, S.push.cy - S.push.sy) > 4) S.mask = null;
    applyPush(ev.altKey);
    drawOverlay();
  }
});

function applyPush(fine) {
  const P = S.push;
  if (!P || P.tone == null) return;
  if (S.mask && S.mask.kind === "push") S.mask.width = S.width;
  const dx = P.cx - P.sx, dy = P.cy - P.sy;
  if (P.kind === "light") {
    const a = pushStrength(Math.abs(dy), fine) * (dy < 0 ? 1 : -1);
    S.params.curves.lightness = addTo(P.base.lightness, bump(P.tone, a, S.width));
    hint(`light at tone ${(P.tone * 100).toFixed(0)}%: ${fmt(a * 255)} · width ${S.width.toFixed(2)} ([ ]) · ⌥ finer`);
  } else {
    const d = Math.hypot(dx, dy), a = pushStrength(d, fine);
    const tint = d ? a * dx / d : 0, warm = d ? a * -dy / d : 0;
    S.params.curves.warmth = addTo(P.base.warmth, bump(P.tone, warm, S.width));
    S.params.curves.tint = addTo(P.base.tint, bump(P.tone, tint, S.width));
    hint(`colour at tone ${(P.tone * 100).toFixed(0)}%: warmth ${fmt(warm * 255)}, tint ${fmt(tint * 255)} · width ${S.width.toFixed(2)} ([ ]) · ⌥ finer`);
  }
  render(); drawCurve();
}

window.addEventListener("mouseup", () => {
  S.pan = null;
  if (S.brush) {
    const { kind, x, y, r } = S.brush;
    S.brush = null; hint("");
    if (kind) { S.samples.push({ kind, x, y, r }); renderSamples(); commit(); drawOverlay(); }
    else doProbe({ x, y, r });
  }
  if (S.sampleMove) {
    if (S.sampleMove.moved) S.sampleMove.probe ? refreshProbes() : commit();
    S.sampleMove = null;
  }
  if (S.rotDrag) { S.rotDrag = null; S.rotating = false; commit(); endDrag(); drawOverlay(); }
  if (S.levelLine) {
    const L = S.levelLine; S.levelLine = null; hint("");
    if (Math.hypot(L.x1 - L.x0, L.y1 - L.y0) > 20) {
      const th = Math.atan2(-(L.y1 - L.y0), L.x1 - L.x0) * 180 / Math.PI;
      setAngle(S.params.angle - (th - Math.round(th / 90) * 90));
      commit();
    }
    setLeveling(false); drawOverlay();
  }
  if (S.cropStart) {
    // only the crop changes: exposure, colour and black/white points stay as they are
    const c = S.cropDrag;
    S.cropStart = null; S.cropDrag = null;
    if (c && c[2] - c[0] > 0.03 && c[3] - c[1] > 0.03 && JSON.stringify(c) !== JSON.stringify(S.params.crop)) { S.params.crop = c; commit(); }
    drawOverlay();
  }
  if (S.push) {
    const changed = S.push.cx !== S.push.sx || S.push.cy !== S.push.sy;
    S.push = null; S.mask = null; hint(""); drawOverlay();
    if (changed) commit();
    endDrag();
  }
});

// Trackpad: pinch zooms (the browser reports it as ctrl+wheel), two-finger scroll pans.
// During a push, scrolling changes the width instead.
overlay.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const b = overlay.getBoundingClientRect();
  if (S.push) return;
  if (ev.ctrlKey) { zoomAt(ev.clientX - b.left, ev.clientY - b.top, Math.exp(-ev.deltaY * 0.01)); return; }
  if (S.view.scale > 1) {
    const r = fitRect();
    S.view.cx += ev.deltaX / r.w; S.view.cy += ev.deltaY / r.h;
    clampView(); drawImage(); scheduleDetail();
  }
}, { passive: false });

// Safari reports pinches as gesture events.
let gestureBase = 1;
overlay.addEventListener("gesturestart", (ev) => { ev.preventDefault(); gestureBase = S.view.scale; });
overlay.addEventListener("gesturechange", (ev) => {
  ev.preventDefault();
  const b = overlay.getBoundingClientRect();
  zoomAt(ev.clientX - b.left, ev.clientY - b.top, (gestureBase * ev.scale) / S.view.scale);
});
overlay.addEventListener("gestureend", (ev) => ev.preventDefault());
overlay.addEventListener("dblclick", (ev) => {
  if (S.tool !== "probe") return;
  const b = overlay.getBoundingClientRect();
  if (S.view.scale > 1) fitView(); else zoomAt(ev.clientX - b.left, ev.clientY - b.top, 3);
});

// Probes stay pinned (up to 8) and update after every edit, so you can watch
// several spots at once on the curves.
const PROBE_COLORS = ["#ffffff", "#7fd4ff", "#ffb36b", "#b0ff7a", "#ff8ad8", "#fff27a", "#a8a8ff", "#7affd9"];

async function doProbe(at) {
  const pr = await api("probe", { params: S.params, at });
  S.probes.push({ at, res: pr });
  if (S.probes.length > PROBE_COLORS.length) S.probes.shift();
  S.probeSel = S.probes.length - 1;
  showProbe(); drawOverlay(); drawCurve();
}

function refreshProbes() {
  clearTimeout(refreshProbes.t);
  if (!S.probes.length) return;
  refreshProbes.t = setTimeout(async () => {
    try {
      const r = await api("probes", { params: S.params, at: S.probes.map((p) => p.at) });
      r.probes.forEach((res, i) => { if (S.probes[i]) S.probes[i].res = res; });
      showProbe(); drawCurve();
    } catch (e) { console.error(e); }
  }, 150);
}

function hint(t) { $("#hint").textContent = t; }
const fmt = (v, d = 1) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d);

function castWords(a, b) {
  const c = Math.hypot(a, b);
  if (c < 0.004) return "neutral grey";
  const parts = [];
  if (Math.abs(b) > 0.003) parts.push(b > 0 ? "yellow" : "blue");
  if (Math.abs(a) > 0.003) parts.push(a > 0 ? "magenta" : "green");
  const how = c < 0.012 ? "slightly " : c < 0.03 ? "" : "strongly ";
  return how + parts.join("-") + (c >= 0.03 ? " (a coloured object rather than a grey)" : "");
}

function showProbe() {
  const box = $("#probe");
  if (!S.probes.length) { box.innerHTML = "Measure tool: click a spot or drag an area. Each click pins a point (P1, P2, …); hover one for a red × to remove it (or press Delete), drag it to move it."; return; }
  const sel = clamp(S.probeSel ?? S.probes.length - 1, 0, S.probes.length - 1);
  const rows = S.probes.map((q, i) => `<li data-type="probe" data-i="${i}" class="${i === sel ? "sel" : ""}"><span class="dot" style="background:${PROBE_COLORS[i % PROBE_COLORS.length]}"></span>
    <span>P${i + 1}</span><span class="res">${(q.res.tone * 100).toFixed(0)}% · ${castWords(q.res.a, q.res.b).replace(/ \(.*\)/, "")}</span><button title="Remove">×</button></li>`).join("");
  box.innerHTML = `<ul id="probe-list">${rows}</ul><div id="probe-detail"></div><button id="probe-clear">Clear probes</button>`;
  box.querySelectorAll("li").forEach((li) => {
    const i = +li.dataset.i;
    li.onclick = () => { S.probeSel = i; showProbe(); };
    li.onmouseenter = () => setHighlight({ type: "probe", i });
    li.onmouseleave = () => setHighlight(null);
    li.querySelector("button").onclick = (e) => { e.stopPropagation(); deleteMark({ type: "probe", i }); };
  });
  $("#probe-clear").onclick = () => { S.probes = []; showProbe(); drawOverlay(); drawCurve(); };
  showProbeDetail(S.probes[sel].res, "P" + (sel + 1));
}

function showProbeDetail(p, name) {
  const rgb = (v) => v.map((x) => Math.round(x * 255)).join(" / ");
  const zone = ["0", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][Math.round(p.tone * 10)];
  const skin = Math.abs(p.skin_hue_off) < 5 ? "matches typical skin" :
    `${Math.abs(p.skin_hue_off).toFixed(0)}° ${p.skin_hue_off > 0 ? "more yellow" : "more red/pink"} than typical skin`;
  $("#probe-detail").innerHTML = `<div class="muted small">${name}:</div><table>
    <tr><td>original</td><td>R/G/B ${rgb(p.input)} (as scanned)</td></tr>
    <tr><td>now</td><td>R/G/B ${rgb(p.output)} (with your edits)</td></tr>
    <tr><td>brightness</td><td>${(p.tone * 100).toFixed(0)}% · about zone ${zone} · marked on the curves</td></tr>
    <tr><td>colour</td><td>${castWords(p.a, p.b)}<br><span class="muted">yellow↔blue ${fmt(p.b * 1000, 0)}, magenta↔green ${fmt(p.a * 1000, 0)} (0 = grey; under ±4 looks neutral)</span></td></tr>
    <tr><td>if skin</td><td>${skin}</td></tr></table>`;
}

// ---------------------------------------------------------------- samples
function renderCasts() {
  const C = S.casts, box = $("#casts");
  if (!C) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="cast-summary">${C.summary}</div>` + C.lines.map((l) =>
    `<div class="cast-line${l.cast ? " has-cast" : ""}"><b>${l.band}</b> ${l.text}${l.src ? ` <span class="muted">(${l.src})</span>` : ""}</div>`).join("");
}

function renderSamples() {
  renderCasts();
  const ul = $("#samples");
  ul.innerHTML = "";
  $("#samples-empty").hidden = S.samples.length > 0;
  S.samples.forEach((s, i) => {
    const r = S.report[i];
    let txt = "", bad = false;
    if (r) {
      if (s.kind === "skin") { txt = `hue ${fmt(r.hue_off, 0)}°`; bad = Math.abs(r.hue_off) > 8; }
      else { txt = `a ${fmt(r.da)} · b ${fmt(r.db)}  L ${(r.L * 100).toFixed(0)}`; bad = Math.hypot(r.da, r.db) > 4; }
    }
    const li = document.createElement("li");
    li.dataset.type = "sample"; li.dataset.i = i;
    li.onmouseenter = () => setHighlight({ type: "sample", i });
    li.onmouseleave = () => setHighlight(null);
    li.innerHTML = `<span class="dot" style="background:${KIND_COLOR[s.kind]}"></span><span>${i + 1} ${s.kind}</span><span class="res ${bad ? "bad" : ""}">${txt}</span><button title="Remove">×</button>`;
    li.querySelector("button").onclick = () => deleteMark({ type: "sample", i });
    ul.appendChild(li);
  });
}

async function refreshReport() {
  clearTimeout(refreshReport.t);
  refreshReport.t = setTimeout(async () => {
    try { const r = await api("report", { params: S.params, samples: S.samples }); S.report = r.report; S.casts = r.casts; renderSamples(); }
    catch (e) { console.error(e); }
  }, 300);
}

// ---------------------------------------------------------------- curves panel
const curveCanvas = $("#curve");
const CURVE_COLORS = { lightness: "#ddd", r: "#f66", g: "#6d6", b: "#69f", warmth: "#e8c040", tint: "#d070d0" };

function curveGeom() {
  const W = curveCanvas.width, H = curveCanvas.height, pad = 14;
  const classic = isClassic(), z = classic ? 0.04 : S.zoom;
  return { W, H, pad, classic, x: (t) => pad + t * (W - 2 * pad), t: (px) => (px - pad) / (W - 2 * pad),
           // classic: output over input with the diagonal; otherwise the change alone, magnified
           y: classic ? (o) => H - pad - o * (H - 2 * pad) : (v) => H / 2 - (v / z) * (H / 2 - pad),
           base: classic ? (t) => t : () => 0 };
}

// The classic view (output over input, with the diagonal) for Light and R/G/B.
const isClassic = () => S.curveView === "classic" && S.curve !== "colour";
const curveNames = () => (S.curve === "colour" ? ["warmth", "tint"] : [S.curve]);  // drawn
const editNames = () => (S.curve === "colour" ? [S.colourCurve] : [S.curve]);       // editable

// What colour the image moves towards when each curve goes up (first) or down.
const CURVE_DIRECTIONS = {
  warmth: ["#ffd23c", "#3c78ff"], tint: ["#e040e0", "#40e040"], lightness: ["#ffffff", "#000000"],
  r: ["#ff4040", "#30e0e0"], g: ["#40e040", "#e040e0"], b: ["#4070ff", "#ffe040"],
};

function drawCurve() {
  if (!S.params) return;
  const ctx = curveCanvas.getContext("2d"), g = curveGeom();
  ctx.clearRect(0, 0, curveCanvas.width, curveCanvas.height);

  // background: the colour the image moves towards above and below the line
  const dirName = editNames()[0];
  const [up, down] = CURVE_DIRECTIONS[dirName];
  const bg = ctx.createLinearGradient(0, 0, 0, g.H);
  bg.addColorStop(0, up); bg.addColorStop(0.5, "rgba(0,0,0,0)"); bg.addColorStop(1, down);
  ctx.globalAlpha = 0.06; ctx.fillStyle = bg; ctx.fillRect(0, 0, g.W, g.H); ctx.globalAlpha = 1;

  // histogram of the current preview behind everything
  if (S.hist) {
    const h = S.hist[S.curve === "colour" ? "lightness" : S.curve], B = h.length;
    let max = 0; for (let i = 2; i < B - 2; i++) max = Math.max(max, h[i]);
    ctx.fillStyle = "rgba(255,255,255,.09)";
    ctx.beginPath(); ctx.moveTo(g.x(0), g.H);
    for (let i = 0; i < B; i++) ctx.lineTo(g.x((i + 0.5) / B), g.H - Math.min(1, Math.sqrt(h[i] / (max || 1))) * (g.H - g.pad));
    ctx.lineTo(g.x(1), g.H); ctx.closePath(); ctx.fill();
  }

  // zones and grid
  ctx.font = "13px sans-serif"; ctx.textAlign = "center";
  for (let i = 0; i <= 10; i++) {
    const x = g.x(i / 10);
    ctx.strokeStyle = i % 5 ? "#2f2f2f" : "#3a3a3a"; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, g.H); ctx.stroke();
    if (i > 0 && i < 10) { ctx.fillStyle = "#555"; ctx.fillText(["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"][i], x, g.H - 3); }
  }
  if (g.classic) {
    for (const v of [0.25, 0.5, 0.75]) { ctx.strokeStyle = "#2f2f2f"; ctx.beginPath(); ctx.moveTo(0, g.y(v)); ctx.lineTo(g.W, g.y(v)); ctx.stroke(); }
    ctx.strokeStyle = "#555"; ctx.beginPath(); ctx.moveTo(g.x(0), g.y(0)); ctx.lineTo(g.x(1), g.y(1)); ctx.stroke();
  } else {
    const z = S.zoom;
    for (const v of [-0.75, -0.5, -0.25, 0.25, 0.5, 0.75]) {
      ctx.strokeStyle = "#2f2f2f"; ctx.beginPath(); ctx.moveTo(0, g.y(v * z)); ctx.lineTo(g.W, g.y(v * z)); ctx.stroke();
    }
    ctx.strokeStyle = "#666"; ctx.beginPath(); ctx.moveTo(0, g.y(0)); ctx.lineTo(g.W, g.y(0)); ctx.stroke();
    ctx.fillStyle = "#666"; ctx.textAlign = "left";
    ctx.fillText(`+${Math.round(z * 255)}`, 2, 12); ctx.fillText(`−${Math.round(z * 255)}`, 2, g.H - 16);
  }

  // falloff preview: where a drag from here would act, and how wide
  const shown = S.curveDrag || S.hoverEdit;
  if (shown) {
    ctx.fillStyle = "rgba(255,255,255,.07)";
    for (let px = 0; px < g.W; px += 2) {
      const w = Math.exp(-0.5 * ((g.t(px) - shown.t) / shown.width) ** 2);
      ctx.fillRect(px, g.H / 2 - w * (g.H / 2 - g.pad), 2, 2 * w * (g.H / 2 - g.pad));
    }
  }

  if (S.curve === "colour") {
    ctx.textAlign = "right";
    ctx.fillStyle = CURVE_COLORS.warmth; ctx.fillText("warmth: yellow ↑ blue ↓", g.W - 6, 16);
    ctx.fillStyle = CURVE_COLORS.tint; ctx.fillText("tint: magenta ↑ green ↓", g.W - 6, 32);
  }
  for (const name of curveNames()) {
    const ctrl = S.params.curves[name];
    const active = editNames().includes(name);
    const pts = [];
    for (let i = 0; i <= 200; i++) pts.push([i / 200, splineAt(ctrl, i / 200)]);
    // curvature comb: second difference drawn as hairlines from the curve
    ctx.strokeStyle = CURVE_COLORS[name] + "55"; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 1; i < pts.length - 1 && !g.classic; i += 2) {
      const k = (pts[i - 1][1] - 2 * pts[i][1] + pts[i + 1][1]) * 200 * 200;
      const x = g.x(pts[i][0]), y = g.y(pts[i][1]);
      ctx.moveTo(x, y); ctx.lineTo(x, y + k * 0.01 / S.zoom * 4);
    }
    ctx.stroke();
    ctx.strokeStyle = CURVE_COLORS[name]; ctx.lineWidth = active ? 2.5 : 1.2; ctx.globalAlpha = active ? 1 : 0.55;
    ctx.beginPath();
    pts.forEach(([t, v], i) => (i ? ctx.lineTo(g.x(t), g.y(g.base(t) + v)) : ctx.moveTo(g.x(t), g.y(g.base(t) + v))));
    ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = CURVE_COLORS[name] + "99";
    if (!g.classic) ctrl.forEach((v, i) => { ctx.beginPath(); ctx.arc(g.x(CTRL_POS[i]), g.y(v), 2, 0, 7); ctx.fill(); });
  }

  // where each probe sits on the curve(s): its tone, or its channel value in R/G/B
  ctx.font = "12px sans-serif"; ctx.textAlign = "center";
  S.probes.forEach((q, i) => {
    const t = ["r", "g", "b"].includes(S.curve) ? q.res.output["rgb".indexOf(S.curve)] : q.res.tone;
    const col = PROBE_COLORS[i % PROBE_COLORS.length];
    ctx.strokeStyle = col; ctx.setLineDash([4, 3]); ctx.lineWidth = i === S.probeSel ? 1.6 : 1;
    const ly = 12 + (i % 3) * 13;  // stagger labels so neighbours stay readable
    ctx.beginPath(); ctx.moveTo(g.x(t), ly + 2); ctx.lineTo(g.x(t), g.H); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = col; ctx.fillText("P" + (i + 1), g.x(t), ly);
  });
  if (S.push && S.push.tone != null) {
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(g.x(S.push.tone), 0); ctx.lineTo(g.x(S.push.tone), g.H); ctx.stroke();
  }

  // while dragging: a swatch of the colour you're pushing towards
  if (S.curveDrag && S.curveDrag.amount) {
    const D = S.curveDrag, [u, d] = CURVE_DIRECTIONS[D.name];
    ctx.fillStyle = D.amount > 0 ? u : d; ctx.strokeStyle = "#888"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(g.x(D.t), g.pad + 12, 9, 0, 7); ctx.fill(); ctx.stroke();
  }

}

// How wide an edit starting at canvas point (px, py) would be: narrow when you
// grab right on the curve, broader the further away from it you press.
function editAt(px, py) {
  const g = curveGeom(), t = clamp(g.t(px), 0, 1);
  let best = null;
  for (const name of editNames()) {
    const d = Math.abs(py - g.y(g.base(t) + splineAt(S.params.curves[name], t)));
    if (!best || d < best.d) best = { name, d };
  }
  const near = 12 * curveCanvas.width / curveCanvas.clientWidth;
  const far = Math.max(0, best.d - near) / (g.H / 2 - g.pad);
  return { name: best.name, t, width: 0.04 + 0.9 * Math.min(far, 1.3) ** 1.5 };
}

const canvasPoint = (ev) => {
  const b = curveCanvas.getBoundingClientRect(), sc = curveCanvas.width / b.width;
  return { x: (ev.clientX - b.left) * sc, y: (ev.clientY - b.top) * sc, sc };
};

curveCanvas.addEventListener("mousedown", (ev) => {
  if (ev.button !== 0) return;
  const p = canvasPoint(ev);
  const e = editAt(p.x, p.y);
  S.curveDrag = { ...e, y0: p.y, amount: 0, base: clone(S.params.curves) };
  startDrag(); drawCurve();
});

window.addEventListener("mousemove", (ev) => {
  const p = canvasPoint(ev), g = curveGeom();
  if (!S.curveDrag) {
    if (ev.target === curveCanvas) {
      S.hoverEdit = editAt(p.x, p.y); drawCurve();
    }
    return;
  }
  const D = S.curveDrag;
  const gain = ev.altKey ? 0.2 : ev.shiftKey ? 3 : 1;
  D.amount = -(p.y - D.y0) * (g.classic ? 1 : S.zoom) / (g.H - 2 * g.pad) * gain;
  S.params.curves[D.name] = addTo(D.base[D.name], bump(D.t, D.amount, D.width));
  drawCurve(); render();
});

window.addEventListener("mouseup", () => {
  if (S.curveDrag) { S.curveDrag = null; commit(); endDrag(); drawCurve(); }
});
curveCanvas.addEventListener("mouseleave", () => { S.hoverEdit = null; drawCurve(); });
// Smooth the shown curve(s), like Rhino's Smooth: each control value moves part of
// the way towards the average of its neighbours. Repeat for more.
function smoothCurves() {
  for (const n of editNames()) {
    const c = S.params.curves[n];
    S.params.curves[n] = c.map((v, i) => {
      const l = c[Math.max(0, i - 1)], r = c[Math.min(c.length - 1, i + 1)];
      return v + 0.5 * ((l + r) / 2 - v);
    });
  }
  drawCurve(); render(); commit();
}
$("#btn-smooth").onclick = smoothCurves;

function resetCurves() {
  for (const n of editNames()) S.params.curves[n] = Array(N_CTRL).fill(0);
  drawCurve(); render(); commit();
}
curveCanvas.addEventListener("dblclick", resetCurves);
$("#btn-curve-reset").onclick = resetCurves;

// ---------------------------------------------------------------- levels panel (classic, like Pixelmator Pro)
// Histogram of the image before levels, black/grey/white input handles under it,
// output black/white below that. RGB moves all three channels; R, G, B one each.
const levelsCanvas = $("#levels");
const LV_HIST = 150, LV_IN = 24, LV_GAP = 14, LV_OUT = 24;

function levelGeom() {
  const W = levelsCanvas.width, pad = 12, [v0, v1] = S.levelView, span = W - 2 * pad;
  return {
    W, pad, span, inY: LV_HIST, outY: LV_HIST + LV_IN + LV_GAP,
    x: (v) => pad + (v - v0) / (v1 - v0) * span, v: (px) => v0 + (px - pad) / span * (v1 - v0),
    ox: (v) => pad + v * span,
  };
}

const curLevel = () => S.params.levels[S.levelCh];
const midPos = (L) => L.lo + (L.hi - L.lo) * 0.5 ** L.gamma;

// One levels stage (mirrors pipeline.apply_level); y is clipped to 0..1 like a classic levels.
function levelY(x, L) { return clamp((x - L.lo) / Math.max(L.hi - L.lo, 1e-3), 0, 1); }

function scheduleLevelHist() {
  const p = clone(S.params);
  for (const k of ["levels", "curves", "saturation", "lighting"]) delete p[k];
  const key = JSON.stringify(p);
  if (key === S.levelHistKey) return;
  clearTimeout(scheduleLevelHist.t);
  scheduleLevelHist.t = setTimeout(async () => {
    try {
      const [r, pre] = await Promise.all([api("histogram", { params: S.params, bins: 2048 }), fetchPre(S.params)]);
      S.levelHist = r; S.pre = pre; S.levelHistKey = key; S.clipCache = null; drawLevels();
      if (S.mask && S.mask.kind === "clip") drawOverlay();
    } catch (e) { console.error(e); }
  }, S.dragging ? 250 : 60);
}

// The image before levels, 16-bit, for the clipping overlay: {w, h, data: Uint16Array}.
const fetchPre = (params) => fetchRGB16("prelevels", params);

async function fetchRGB16(route, params) {
  busy(1);
  try {
    const res = await fetch("/api/" + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params }) });
    if (!res.ok) throw new Error(res.statusText);
    const [w, h] = res.headers.get("X-Size").split("x").map(Number);
    return { w, h, data: new Uint16Array(await res.arrayBuffer()) };
  } finally { busy(-1); }
}

// Clipping overlay, computed here from the image before levels, so it follows a drag
// instantly. Like Lightroom's clipping warning: only pixels that actually clip,
// red for white and blue for black, with a one-level soft edge.
const CLIP_BAND = 0.01;
function clipCanvas() {
  const P = S.pre;
  if (!P || P.w * P.h * 3 !== P.data.length) return null;
  const key = JSON.stringify(S.params.levels) + S.levelCh + P.w;
  if (S.clipCache && S.clipCache.key === key) return S.clipCache.canvas;
  const chans = S.levelCh === "rgb" ? [0, 1, 2] : ["rgb".indexOf(S.levelCh)], M = S.params.levels.rgb;
  const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  // per channel, a table from the 12 high bits of the value to highlight and shadow strength
  const N = 4096, hiT = [], loT = [];
  for (const c of chans) {
    const L = S.params.levels["rgb"[c]], hi = new Float32Array(N), lo = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const x = (k + 0.5) / N, u = (x - L.lo) / Math.max(L.hi - L.lo, 1e-3), uc = clamp(u, 0, 1);
      const out = L.out_lo + (L.gamma === 1 ? uc : uc ** (1 / L.gamma)) * (L.out_hi - L.out_lo);
      const v = (out - M.lo) / Math.max(M.hi - M.lo, 1e-3);
      hi[k] = smooth(1 - CLIP_BAND, 1, Math.max(u, v));
      lo[k] = 1 - smooth(0, CLIP_BAND, Math.min(u, v));
    }
    hiT.push(hi); loT.push(lo);
  }
  const c = S.clipCache?.canvas || document.createElement("canvas");
  if (c.width !== P.w || c.height !== P.h) { c.width = P.w; c.height = P.h; }
  const ctx = c.getContext("2d"), im = ctx.createImageData(P.w, P.h), o = im.data, d = P.data, n = P.w * P.h;
  for (let i = 0; i < n; i++) {
    let h = 0, l = 0;
    for (let j = 0; j < chans.length; j++) {
      const k = d[i * 3 + chans[j]] >> 4;
      if (hiT[j][k] > h) h = hiT[j][k];
      if (loT[j][k] > l) l = loT[j][k];
    }
    if (h >= l && h > 0) { o[i * 4] = 235; o[i * 4 + 1] = 45; o[i * 4 + 2] = 45; o[i * 4 + 3] = h * 180; }
    else if (l > 0) { o[i * 4] = 30; o[i * 4 + 1] = 100; o[i * 4 + 2] = 235; o[i * 4 + 3] = l * 180; }
  }
  ctx.putImageData(im, 0, 0);
  S.clipCache = { key, canvas: c };
  return c;
}

// Share of pixels pushed to pure black or white by the levels, for the shown channel(s).
function levelClipping() {
  const H = S.levelHist;
  if (!H) return null;
  const chans = S.levelCh === "rgb" ? [0, 1, 2] : ["rgb".indexOf(S.levelCh)], M = S.params.levels.rgb;
  let lo = 0, hi = 0, n = 0;
  for (const c of chans) {
    const Lc = S.params.levels["rgb"[c]], h = H.hist[c];
    let clo = 0, chi = 0, cn = 0;
    for (let i = 0; i < H.bins; i++) {
      if (!h[i]) continue;
      const x = (i + 0.5) / H.bins, y = levelY(x, Lc), out = Lc.out_lo + (Lc.gamma === 1 ? y : y ** (1 / Lc.gamma)) * (Lc.out_hi - Lc.out_lo);
      cn += h[i];
      if (y <= 0 || levelY(out, M) <= 0) clo += h[i];
      else if (y >= 1 || levelY(out, M) >= 1) chi += h[i];
    }
    lo = Math.max(lo, clo / cn); hi = Math.max(hi, chi / cn); n = cn;
  }
  return n ? { lo, hi } : null;
}

// Gaussian blur of a 1-D array (edges clamped), to take the noise out of the histogram.
function blur1d(a, sigma) {
  const r = Math.ceil(sigma * 3), k = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-0.5 * (i / sigma) ** 2));
  const ks = k.reduce((x, y) => x + y), out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let sum = 0;
    for (let j = -r; j <= r; j++) sum += a[clamp(i + j, 0, a.length - 1)] * k[j + r];
    out[i] = sum / ks;
  }
  return out;
}

function drawLevels() {
  if (!S.params) return;
  const ctx = levelsCanvas.getContext("2d"), g = levelGeom(), L = curLevel();
  ctx.clearRect(0, 0, levelsCanvas.width, levelsCanvas.height);

  // histogram: one column per pixel, the average count of the bins it covers
  const H = S.levelHist;
  if (H) {
    const chans = S.levelCh === "rgb" ? [0, 1, 2] : ["rgb".indexOf(S.levelCh)];
    // muted channel colours that add up to a neutral grey where all three overlap, as in Lightroom
    const colors = S.levelCh === "rgb" ? ["rgba(181,82,79,.55)", "rgba(90,154,90,.55)", "rgba(79,111,181,.55)"] : null;
    const cols = [];
    for (const c of chans) {
      const h = H.hist[c], col = new Float32Array(g.span);
      for (let px = 0; px < g.span; px++) {
        const b0 = Math.floor(g.v(g.pad + px) * H.bins), b1 = Math.max(b0 + 1, Math.floor(g.v(g.pad + px + 1) * H.bins));
        let sum = 0, cnt = 0;
        for (let b = Math.max(0, b0); b < Math.min(H.bins, b1); b++) { sum += h[b]; cnt++; }
        col[px] = cnt ? sum / cnt : 0;
      }
      cols.push(blur1d(col, Math.max(2.5, 0.6 * g.span / ((S.levelView[1] - S.levelView[0]) * H.bins))));
    }
    // scale to the tall but not extreme columns, so a spike at pure black or white doesn't flatten everything
    const all = cols.flatMap((c) => [...c]).filter((v) => v > 0).sort((a, b) => a - b);
    const norm = (all[Math.floor(all.length * 0.985)] || 1) * 1.1;
    ctx.globalCompositeOperation = "lighter";
    cols.forEach((col, k) => {
      ctx.fillStyle = colors ? colors[k] : { r: "rgba(201,98,94,.8)", g: "rgba(104,170,104,.8)", b: "rgba(96,128,200,.8)" }[S.levelCh];
      ctx.beginPath(); ctx.moveTo(g.pad, LV_HIST);
      for (let px = 0; px < g.span; px++) ctx.lineTo(g.pad + px + 0.5, LV_HIST - Math.min(1, col[px] / norm) * (LV_HIST - 8));
      ctx.lineTo(g.pad + g.span, LV_HIST); ctx.closePath(); ctx.fill();
    });
    ctx.globalCompositeOperation = "source-over";
  }

  // veil over what the black and white points cut off
  ctx.fillStyle = "rgba(0,0,0,.45)";
  const xl = clamp(g.x(L.lo), g.pad, g.pad + g.span), xh = clamp(g.x(L.hi), g.pad, g.pad + g.span);
  ctx.fillRect(g.pad, 0, xl - g.pad, LV_HIST); ctx.fillRect(xh, 0, g.pad + g.span - xh, LV_HIST);

  // zoom: show the visible range
  const [v0, v1] = S.levelView;
  if (v1 - v0 < 0.999) {
    ctx.fillStyle = "#999"; ctx.font = "16px sans-serif";
    ctx.textAlign = "left"; ctx.fillText(Math.round(v0 * 255), g.pad + 2, 17);
    ctx.textAlign = "right"; ctx.fillText(Math.round(v1 * 255), g.pad + g.span - 2, 17);
    ctx.textAlign = "center"; ctx.fillText(`${Math.round(1 / (v1 - v0))}×`, g.W / 2, 17);
  }

  // input ramp and handles
  const ramp = (x0, x1, y) => {
    const gr = ctx.createLinearGradient(x0, 0, x1, 0);
    gr.addColorStop(0, "#000"); gr.addColorStop(1, "#fff");
    ctx.fillStyle = gr; ctx.fillRect(g.pad, y, g.span, 5);
  };
  ramp(g.x(0), g.x(1), g.inY + 3);
  const tri = (x, y, fill) => {
    ctx.fillStyle = fill; ctx.strokeStyle = "#aaa"; ctx.lineWidth = 1.5;
    if (x < g.pad - 9 || x > g.pad + g.span + 9) {  // zoomed past it: a small arrow at the edge points to it
      const e = x < g.pad ? 2 : g.W - 2, d = x < g.pad ? 1 : -1;
      ctx.beginPath(); ctx.moveTo(e, y + 14); ctx.lineTo(e + 9 * d, y + 8); ctx.lineTo(e + 9 * d, y + 20); ctx.closePath(); ctx.fill(); ctx.stroke();
      return;
    }
    ctx.beginPath(); ctx.moveTo(x, y + 8); ctx.lineTo(x - 8, y + 21); ctx.lineTo(x + 8, y + 21); ctx.closePath(); ctx.fill(); ctx.stroke();
  };
  tri(g.x(L.lo), g.inY, "#000"); tri(g.x(midPos(L)), g.inY, "#808080"); tri(g.x(L.hi), g.inY, "#fff");

  // output ramp and handles (always the whole range)
  ramp(g.ox(0), g.ox(1), g.outY + 3);
  tri(g.ox(L.out_lo), g.outY, "#000"); tri(g.ox(L.out_hi), g.outY, "#fff");

  // numbers and clipping
  const set = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v; };
  set("#lv-lo", Math.round(L.lo * 255)); set("#lv-hi", Math.round(L.hi * 255)); set("#lv-gamma", L.gamma.toFixed(2));
  set("#lv-out-lo", Math.round(L.out_lo * 255)); set("#lv-out-hi", Math.round(L.out_hi * 255));
  const c = levelClipping(), pct = (f) => (f < 0.0005 ? "none" : f < 0.01 ? (f * 100).toFixed(2) + "%" : (f * 100).toFixed(1) + "%");
  $("#lv-clip").textContent = c ? `Clipped to black: ${pct(c.lo)} · to white: ${pct(c.hi)}` : "";
}

function setLevelCh(ch) {
  S.levelCh = ch;
  $$("#level-tabs [data-level]").forEach((b) => b.classList.toggle("active", b.dataset.level === ch));
  drawLevels();
}
$$("#level-tabs [data-level]").forEach((b) => (b.onclick = () => setLevelCh(b.dataset.level)));

function setLevelView(v0, v1) {
  const w = clamp(v1 - v0, 1 / 32, 1);
  v0 = clamp(v0, 0, 1 - w);
  S.levelView = [v0, v0 + w];
  const sel = $("#level-zoom"), key = S.levelView.map((v) => +v.toFixed(4)).join(",");
  sel.value = [...sel.options].some((o) => o.value === key) ? key : "custom";
  drawLevels();
}
$("#level-zoom").onchange = (e) => { if (e.target.value === "custom") return; const [a, b] = e.target.value.split(",").map(Number); setLevelView(a, b); };

const levelPoint = (ev) => {
  const b = levelsCanvas.getBoundingClientRect(), sc = levelsCanvas.width / b.width;
  return { x: (ev.clientX - b.left) * sc, y: (ev.clientY - b.top) * sc, sc };
};

// Which handle a press at p grabs, if any.
function levelHandleAt(p) {
  const g = levelGeom(), L = curLevel(), near = (x) => Math.abs(p.x - x);
  let opts = null;
  if (p.y >= g.inY && p.y < g.outY - 4) opts = [["lo", g.x(L.lo)], ["mid", g.x(midPos(L))], ["hi", g.x(L.hi)]];
  else if (p.y >= g.outY - 4) opts = [["out_lo", g.ox(L.out_lo)], ["out_hi", g.ox(L.out_hi)]];
  if (!opts) return null;
  const best = opts.reduce((a, b) => (near(b[1]) < near(a[1]) ? b : a));
  return near(best[1]) < 16 ? best[0] : null;
}

// Move one handle to a value (input handles in 0..1 of the input, output handles of the output).
function setLevelHandle(which, v) {
  const L = curLevel();
  if (which === "lo") L.lo = clamp(v, 0, L.hi - 2 / 255);
  else if (which === "hi") L.hi = clamp(v, L.lo + 2 / 255, 1);
  else if (which === "mid") {
    const m = clamp(v, L.lo + 0.002, L.hi - 0.002);
    L.gamma = clamp(Math.log((m - L.lo) / (L.hi - L.lo)) / Math.log(0.5), 0.1, 9.99);
  } else if (which === "out_lo") L.out_lo = clamp(v, 0, L.out_hi - 2 / 255);
  else L.out_hi = clamp(v, L.out_lo + 2 / 255, 1);
}

const levelValue = (which, L) => (which === "mid" ? midPos(L) : L[which]);

// A press on a handle grabs it. A press anywhere else in the histogram or the
// input bar moves the nearest of black / grey / white there (even if it is
// outside the zoomed view), and the output bar likewise for the output handles.
levelsCanvas.addEventListener("mousedown", (ev) => {
  if (ev.button !== 0) return;
  const p = levelPoint(ev), g = levelGeom(), L = curLevel();
  if (S.levelMagnify && p.y < g.outY - 4) {  // magnifier: click zooms in there, ⌥-click zooms out
    const at = clamp(g.v(p.x), 0, 1), f = ev.altKey ? 2 : 0.5, [v0, v1] = S.levelView;
    setLevelView(at - (at - v0) * f, at + (v1 - at) * f);
    return;
  }
  let which = levelHandleAt(p);
  if (!which) {
    const out = p.y >= g.outY - 4, v = out ? clamp((p.x - g.pad) / g.span, 0, 1) : clamp(g.v(p.x), 0, 1);
    const opts = out ? ["out_lo", "out_hi"] : ["lo", "mid", "hi"];
    which = opts.reduce((a, b) => (Math.abs(levelValue(b, L) - v) < Math.abs(levelValue(a, L) - v) ? b : a));
    setLevelHandle(which, v);
    render();
  }
  S.levelDrag = { which, x0: p.x, start: levelValue(which, curLevel()) };
  if (which === "lo" || which === "hi") S.mask = { kind: "clip" };
  startDrag(); drawLevels(); drawOverlay();
});

window.addEventListener("mousemove", (ev) => {
  if (!S.levelDrag) {
    if (ev.target === levelsCanvas) levelsCanvas.style.cursor = S.levelMagnify ? (ev.altKey ? "zoom-out" : "zoom-in") : levelHandleAt(levelPoint(ev)) ? "ew-resize" : "pointer";
    return;
  }
  const D = S.levelDrag, p = levelPoint(ev), g = levelGeom();
  const dx = (p.x - D.x0) / g.span, scale = D.which.startsWith("out") ? 1 : S.levelView[1] - S.levelView[0];
  setLevelHandle(D.which, D.start + dx * scale);
  drawLevels(); render();
  if (S.mask) { cancelAnimationFrame(S.clipFrame); S.clipFrame = requestAnimationFrame(drawOverlay); }
});

window.addEventListener("mouseup", () => {
  if (S.levelDrag) { S.levelDrag = null; if (S.mask && S.mask.kind === "clip") { S.mask = null; drawOverlay(); } commit(); endDrag(); }
});

// Trackpad: pinch zooms around the pointer (browsers report it as ctrl+wheel,
// Safari as gesture events); sideways two-finger scroll moves along. Plain
// vertical scrolling is left alone so the sidebar still scrolls.
levelsCanvas.addEventListener("wheel", (ev) => {
  const p = levelPoint(ev), g = levelGeom(), [v0, v1] = S.levelView;
  if (ev.ctrlKey) {
    ev.preventDefault();
    const at = clamp(g.v(p.x), 0, 1), f = Math.exp(clamp(ev.deltaY, -30, 30) * 0.012);
    setLevelView(at - (at - v0) * f, at + (v1 - at) * f);
  } else if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
    ev.preventDefault();
    const d = ev.deltaX * p.sc / g.span * (v1 - v0);
    setLevelView(v0 + d, v1 + d);
  }
}, { passive: false });
let levelGesture = null;
levelsCanvas.addEventListener("gesturestart", (ev) => {
  ev.preventDefault();
  const g = levelGeom(), at = clamp(g.v(levelPoint(ev).x), 0, 1);
  levelGesture = { at, view: [...S.levelView] };
});
levelsCanvas.addEventListener("gesturechange", (ev) => {
  ev.preventDefault();
  if (!levelGesture) return;
  const { at, view: [v0, v1] } = levelGesture, f = 1 / ev.scale;
  setLevelView(at - (at - v0) * f, at + (v1 - at) * f);
});
levelsCanvas.addEventListener("gestureend", () => (levelGesture = null));

$("#level-magnify").onclick = () => {
  S.levelMagnify = !S.levelMagnify;
  $("#level-magnify").classList.toggle("active", S.levelMagnify);
};

levelsCanvas.addEventListener("dblclick", (ev) => {
  if (S.levelMagnify) { setLevelView(0, 1); return; }
  const p = levelPoint(ev), which = levelHandleAt(p);
  if (!which) return;
  const L = curLevel();
  if (which.startsWith("out")) { L.out_lo = 0; L.out_hi = 1; } else if (which === "mid") L.gamma = 1; else { L.lo = 0; L.hi = 1; L.gamma = 1; }
  drawLevels(); render(); commit();
});

for (const [id, key, scale] of [["#lv-lo", "lo", 255], ["#lv-hi", "hi", 255], ["#lv-gamma", "gamma", 1], ["#lv-out-lo", "out_lo", 255], ["#lv-out-hi", "out_hi", 255]]) {
  $(id).addEventListener("change", (e) => {
    const L = curLevel(), v = +e.target.value / scale;
    if (!Number.isFinite(v)) return drawLevels();
    if (key === "lo") L.lo = clamp(v, 0, L.hi - 2 / 255);
    else if (key === "hi") L.hi = clamp(v, L.lo + 2 / 255, 1);
    else if (key === "gamma") L.gamma = clamp(v, 0.1, 9.99);
    else if (key === "out_lo") L.out_lo = clamp(v, 0, L.out_hi - 2 / 255);
    else L.out_hi = clamp(v, L.out_lo + 2 / 255, 1);
    e.target.blur(); drawLevels(); render(); commit();
  });
}

// Click a panel title to fold it away; remembered per panel.
$$("aside .panel").forEach((panel, i) => {
  const key = "filmneg.fold." + (panel.id || i);
  try { if (localStorage.getItem(key) === "1") panel.classList.add("collapsed"); } catch (e) { /* ignore */ }
  panel.querySelector("h3").addEventListener("click", () => {
    panel.classList.toggle("collapsed");
    try { localStorage.setItem(key, panel.classList.contains("collapsed") ? "1" : "0"); } catch (e) { /* ignore */ }
  });
});

// ---------------------------------------------------------------- copy / paste settings (roll workflow)
// Crop, rotation and the per-frame automatic black/white points stay with each frame.
const FRAME_ONLY = ["crop", "angle", "black", "white", "base", "mode"];
const settingsOf = (p) => { const c = clone(p); for (const k of FRAME_ONLY) delete c[k]; return c; };

function setClip(c) {
  S.clip = c;
  $("#btn-paste").disabled = $("#btn-paste-roll").disabled = !c;
  try { localStorage.setItem("filmneg.clip", JSON.stringify(c)); } catch (e) { /* ignore */ }
}
try { const c = JSON.parse(localStorage.getItem("filmneg.clip") || "null"); if (c) setClip(c); } catch (e) { /* ignore */ }

function copySettings() { setClip(settingsOf(S.params)); status("Settings copied"); }
function pasteSettings() {
  if (!S.clip) return;
  S.params = { ...S.params, ...clone(S.clip) };
  syncControls(); render(); drawCurve(); commit(); status("Settings pasted");
}
$("#btn-copy").onclick = copySettings;
$("#btn-paste").onclick = pasteSettings;
$("#btn-paste-roll").onclick = () => {
  const others = S.doc.files.filter((f) => f !== S.doc.name);
  if (!S.clip || !others.length) return;
  if (!confirm(`Paste the copied settings onto the other ${others.length} frame(s) in this folder?\n\nTheir crop, rotation and automatic black/white points stay as they are. Their earlier adjustments are kept as a version called “Before paste”.`)) return;
  guard("Paste to roll", async () => {
    const r = await api("paste_roll", { settings: S.clip, names: others });
    status(`Pasted onto ${r.count} frame(s)`, 5000);
  });
};

// ---------------------------------------------------------------- versions (snapshots)
function renderVersions() {
  const ul = $("#versions"), now = JSON.stringify(S.params);
  ul.innerHTML = "";
  (S.versions || []).forEach((v, i) => {
    const li = document.createElement("li");
    li.className = JSON.stringify(v.params) === now ? "current" : "";
    li.title = "Click to switch to this version (undo goes back)";
    li.innerHTML = `<span class="name"></span><span class="when"></span><button title="Delete this version">×</button>`;
    li.querySelector(".name").textContent = v.name;
    li.querySelector(".when").textContent = new Date(v.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    li.onclick = () => { S.params = clone(v.params); syncControls(); render(); drawCurve(); commit(); flash("version", "Switched to " + v.name); };
    li.querySelector(".name").ondblclick = (e) => {
      e.stopPropagation();
      const n = prompt("Name this version", v.name);
      if (n) { v.name = n; renderVersions(); scheduleSave(); }
    };
    li.querySelector("button").onclick = (e) => { e.stopPropagation(); S.versions.splice(i, 1); renderVersions(); scheduleSave(); };
    ul.appendChild(li);
  });
}
$("#btn-version").onclick = () => {
  S.versions = S.versions || [];
  S.versions.push({ name: "Version " + (S.versions.length + 1), time: Date.now(), params: clone(S.params) });
  renderVersions(); scheduleSave();
};

// ---------------------------------------------------------------- controls
const SLIDERS = ["exposure", "contrast", "shoulder", "toe", "saturation", "nr"];
const SLIDER_DEFAULTS = { exposure: 0, contrast: 1, shoulder: 0.5, toe: 0, saturation: 1, nr: 0 };

function syncControls() {
  for (const k of SLIDERS) {
    const el = $("#" + k); el.value = S.params[k];
    el.nextElementSibling.value = (+S.params[k]).toFixed(2);
  }
  $("#lighting").value = S.params.lighting;
  drawLevels();
}

for (const k of SLIDERS) {
  const el = $("#" + k);
  el.addEventListener("input", () => {
    if (!S.dragging && k !== "nr") startDrag();
    S.params[k] = +el.value; el.nextElementSibling.value = (+el.value).toFixed(2); render();
  });
  // the number next to the slider: arrow keys nudge it, typing sets it
  const num = el.nextElementSibling;
  const setValue = (v) => {
    v = clamp(Math.round(v * 100) / 100, +el.min, +el.max);
    S.params[k] = v; el.value = v; num.value = v.toFixed(2); render();
    clearTimeout(num.t); num.t = setTimeout(commit, 500);
  };
  num.addEventListener("focus", () => num.select());
  num.addEventListener("keydown", (ev) => {
    const step = { ArrowUp: 0.1, ArrowDown: -0.1, ArrowRight: 0.01, ArrowLeft: -0.01 }[ev.key];
    if (step) { ev.preventDefault(); setValue(S.params[k] + step * (ev.shiftKey ? 10 : 1)); }
    else if (ev.key === "Enter") { const v = parseFloat(num.value.replace(",", ".").replace("−", "-")); if (Number.isFinite(v)) setValue(v); num.blur(); }
    else if (ev.key === "Escape") { num.value = (+S.params[k]).toFixed(2); num.blur(); }
  });
  num.addEventListener("blur", () => { num.value = (+S.params[k]).toFixed(2); });
  el.addEventListener("change", () => { commit(); endDrag(); });
  el.addEventListener("dblclick", () => { S.params[k] = SLIDER_DEFAULTS[k]; syncControls(); render(); commit(); });
}
$("#lighting").addEventListener("change", (e) => { S.params.lighting = e.target.value; commit(); });

// ---- crop panel: rotation, level by line, aspect, lens distortion, reset
function setGeom(key, v) {
  const lim = key === "angle" ? 45 : 10;
  S.params[key] = clamp(Math.round(v * 100) / 100, -lim, lim);
  $("#" + key).value = S.params[key]; $("#" + key + "-num").value = S.params[key].toFixed(2);
  render();
}
const setAngle = (a) => setGeom("angle", a);
for (const key of ["angle", "distortion"]) {
  const el = $("#" + key), num = $("#" + key + "-num");
  el.addEventListener("input", () => { if (!S.dragging) startDrag(); S.rotating = true; setGeom(key, +el.value); });
  el.addEventListener("change", () => { S.rotating = false; commit(); endDrag(); drawOverlay(); });
  el.addEventListener("dblclick", () => { setGeom(key, 0); commit(); });
  num.addEventListener("focus", () => num.select());
  num.addEventListener("keydown", (ev) => {
    const step = { ArrowUp: 0.1, ArrowDown: -0.1, ArrowRight: 0.01, ArrowLeft: -0.01 }[ev.key];
    if (step) { ev.preventDefault(); setGeom(key, S.params[key] + step * (ev.shiftKey ? 10 : 1)); clearTimeout(num.t); num.t = setTimeout(commit, 500); }
    else if (ev.key === "Enter") { const v = parseFloat(num.value.replace(",", ".").replace("−", "-")); if (Number.isFinite(v)) { setGeom(key, v); commit(); } num.blur(); }
  });
  num.addEventListener("blur", () => (num.value = (+S.params[key]).toFixed(2)));
}

function setLeveling(on) {
  S.leveling = on;
  $("#crop-level").classList.toggle("active", on);
  hint(on ? "draw a line along something that should be level or upright" : "drag on the picture for a new crop, outside it to rotate");
}
$("#crop-level").onclick = () => setLeveling(!S.leveling);

// What a press at screen point (x, y) grabs on the current crop: a corner (with
// the opposite corner as anchor), an edge, the inside (move), or nothing.
function cropHit(x, y) {
  const c = S.params.crop, A = toScreen(c[0], c[1]), B = toScreen(c[2], c[3]), near = 12;
  for (const [xi, yi] of [[0, 1], [2, 1], [2, 3], [0, 3]]) {
    const P = toScreen(c[xi], c[yi]);
    if (Math.hypot(P.x - x, P.y - y) < near) return { corner: true, ax: c[2 - xi], ay: c[4 - yi], cursor: xi === 0 ^ yi === 1 ? "nesw-resize" : "nwse-resize" };
  }
  const inY = y > A.y && y < B.y, inX = x > A.x && x < B.x;
  if (inY && Math.abs(x - A.x) < near / 1.5) return { edge: 0, cursor: "ew-resize" };
  if (inY && Math.abs(x - B.x) < near / 1.5) return { edge: 2, cursor: "ew-resize" };
  if (inX && Math.abs(y - A.y) < near / 1.5) return { edge: 1, cursor: "ns-resize" };
  if (inX && Math.abs(y - B.y) < near / 1.5) return { edge: 3, cursor: "ns-resize" };
  if (inX && inY) return { inside: true, cursor: "move" };
  return null;
}

// Update the crop being dragged for pointer p (scan fractions).
function mousemoveCrop(p) {
  const a = S.cropStart;
  if (a.mode === "corner") S.cropDrag = constrainCrop(a.ax, a.ay, p.x, p.y);
  else if (a.mode === "move") {
    const c = a.c0, w = c[2] - c[0], h = c[3] - c[1];
    const x0 = clamp(c[0] + p.x - a.x, 0, 1 - w), y0 = clamp(c[1] + p.y - a.y, 0, 1 - h);
    S.cropDrag = [x0, y0, x0 + w, y0 + h];
  } else S.cropDrag = dragEdge(a.c0, a.edge, p);
}

// Drag one edge; with a fixed aspect the other dimension follows, centred.
function dragEdge(c0, edge, p) {
  const c = [...c0], v = edge % 2 ? p.y : p.x, min = 0.03;
  c[edge] = edge < 2 ? clamp(v, 0, c0[edge + 2] - min) : clamp(v, c0[edge - 2] + min, 1);
  const r = aspectRatio();
  if (r) {
    const W = S.doc.width, H = S.doc.height, land = (c0[2] - c0[0]) * W >= (c0[3] - c0[1]) * H, rr = land ? r : 1 / r;
    if (edge % 2 === 0) { const h = (c[2] - c[0]) * W / rr / H, m = (c0[1] + c0[3]) / 2; c[1] = m - h / 2; c[3] = m + h / 2; }
    else { const w = (c[3] - c[1]) * H * rr / W, m = (c0[0] + c0[2]) / 2; c[0] = m - w / 2; c[2] = m + w / 2; }
  }
  return c.map((v) => clamp(v, 0, 1));
}

// Aspect ratio as width/height in pixels (>= 1); null = free.
function aspectRatio() {
  const v = $("#aspect").value;
  if (v === "free") return null;
  const r = v === "orig" ? S.doc.width / S.doc.height : +v;
  return Math.max(r, 1 / r);
}
// Fit box [x0, y0, x1, y1] (scan fractions) to the aspect, around anchor (ax, ay) towards (bx, by).
function constrainCrop(ax, ay, bx, by) {
  const r = aspectRatio(), W = S.doc.width, H = S.doc.height;
  if (r) {
    let w = Math.abs(bx - ax) * W, h = Math.abs(by - ay) * H;
    const rr = w >= h ? r : 1 / r;
    if (w / Math.max(h, 1e-6) > rr) w = h * rr; else h = w / rr;
    bx = ax + Math.sign(bx - ax || 1) * w / W; by = ay + Math.sign(by - ay || 1) * h / H;
  }
  return [clamp(Math.min(ax, bx), 0, 1), clamp(Math.min(ay, by), 0, 1), clamp(Math.max(ax, bx), 0, 1), clamp(Math.max(ay, by), 0, 1)];
}
$("#aspect").onchange = () => {
  try { localStorage.setItem("filmneg.aspect", $("#aspect").value); } catch (e) { /* ignore */ }
  const r = aspectRatio(), c = S.params.crop;
  if (!r) return;
  // shrink the current crop around its centre to the new shape
  const W = S.doc.width, H = S.doc.height, cx = (c[0] + c[2]) / 2, cy = (c[1] + c[3]) / 2;
  let w = (c[2] - c[0]) * W, h = (c[3] - c[1]) * H;
  const rr = w >= h ? r : 1 / r;
  if (w / h > rr) w = h * rr; else h = w / rr;
  S.params.crop = [cx - w / W / 2, cy - h / H / 2, cx + w / W / 2, cy + h / H / 2];
  commit(); drawOverlay();
};
try { const a = localStorage.getItem("filmneg.aspect"); if (a) $("#aspect").value = a; } catch (e) { /* ignore */ }

$("#crop-reset").onclick = () => guard("Reset crop", async () => {
  S.params.angle = 0; S.params.distortion = 0;
  S.params.crop = (await api("autocrop", { params: S.params })).crop;
  setGeom("angle", 0); setGeom("distortion", 0); commit(); drawOverlay();
});
$("#crop-done").onclick = () => setTool("probe");

const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M5 12a7 7 0 1 0 2.2-5.1" fill="none" stroke="black" stroke-width="4" stroke-linecap="round"/><path d="M5 12a7 7 0 1 0 2.2-5.1" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"/><path d="M3.5 3.5v5h5" fill="none" stroke="black" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 3.5v5h5" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>')}") 12 12, grab`;

function setTool(t) {
  S.tool = t;
  if (["neutral", "white", "black", "skin"].includes(t)) setShown("samples", true);
  if (t === "probe" && S.probes.length) setShown("probes", true);
  $$("#tools [data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
  overlay.style.cursor = t === "push" ? "move" : t === "light" ? "ns-resize" : "crosshair";
  if (t === "crop") fitView();
  document.body.classList.toggle("cropping", t === "crop");
  if (t === "crop") { setGeom("angle", S.params.angle || 0); setGeom("distortion", S.params.distortion || 0); setLeveling(false); }
  if (t === "crop" || currentFull) render(); else drawOverlay();
  hint({
    push: "click a spot, then drag towards a colour; further = stronger. [ ] = width",
    light: "click a spot, then drag up to brighten or down to darken that brightness. [ ] = width",
    crop: "drag on the picture for a new crop, outside it to rotate",
  }[t] || "");
}
// Eye buttons: show or hide samples / measured points on the image.
function setShown(which, on) {
  S[which === "samples" ? "showSamples" : "showProbes"] = on;
  const b = $(`[data-eye="${which}"]`);
  b.classList.toggle("off", !on);
  b.title = (on ? "Hide " : "Show ") + (which === "samples" ? "samples" : "measured points") + " on the image";
  drawOverlay();
}
$$("[data-eye]").forEach((b) => b.addEventListener("click", (ev) => {
  ev.stopPropagation();  // the title click would fold the panel
  setShown(b.dataset.eye, b.classList.contains("off"));
}));
$$("#tools [data-tool]").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
// Right-click on the image: background colour around it, fit.
function setSurround(c) {
  document.documentElement.style.setProperty("--surround", c);
  $$("[data-surround]").forEach((b) => b.classList.toggle("on", b.dataset.surround === c));
  try { localStorage.setItem("filmneg.surround", c); } catch (e) { /* private mode */ }
}
function closeMenu() { $("#menu").hidden = true; }
$("#viewer").addEventListener("contextmenu", (ev) => {
  ev.preventDefault();
  const m = $("#menu"), b = $("#viewer").getBoundingClientRect();
  m.hidden = false;
  m.style.left = Math.min(ev.clientX - b.left, b.width - m.offsetWidth - 6) + "px";
  m.style.top = Math.min(ev.clientY - b.top, b.height - m.offsetHeight - 6) + "px";
});
$$("[data-surround]").forEach((b) => (b.onclick = () => { setSurround(b.dataset.surround); closeMenu(); }));
$("#menu [data-action=fit]").onclick = () => { fitView(); closeMenu(); };
window.addEventListener("mousedown", (ev) => { if (!$("#menu").contains(ev.target)) closeMenu(); }, true);
try { setSurround(localStorage.getItem("filmneg.surround") || "#808080"); } catch (e) { setSurround("#808080"); }

function setCurve(c) {
  S.curve = c;
  $$("#curve-tabs [data-curve]").forEach((b) => b.classList.toggle("active", b.dataset.curve === c));
  $("#colour-curve").hidden = c !== "colour";
  drawCurve();
}
$("#colour-curve").onchange = (e) => { S.colourCurve = e.target.value; drawCurve(); };
$$("#curve-tabs [data-curve]").forEach((b) => (b.onclick = () => setCurve(b.dataset.curve)));
$("#zoom").onchange = (e) => {
  if (e.target.value === "classic") S.curveView = "classic"; else { S.curveView = "zoom"; S.zoom = +e.target.value; }
  try { localStorage.setItem("filmneg.curveView", e.target.value); } catch (err) { /* ignore */ }
  drawCurve();
};
try { const v = localStorage.getItem("filmneg.curveView"); if (v) { $("#zoom").value = v; $("#zoom").onchange({ target: $("#zoom") }); } } catch (err) { /* ignore */ }

$("#btn-auto").onclick = () => guard("Auto", async () => { S.params = (await api("levels", { params: S.params })).params; syncControls(); render(); commit(); });
$("#btn-solve").onclick = () => guard("Solve", async () => {
  if (!S.samples.length) throw new Error("add some grey, white, black or skin samples first");
  const r = await api("solve", { params: S.params, samples: S.samples });
  S.params = r.params; S.report = r.report; S.casts = r.casts; syncControls(); render(); renderSamples(); commit();
});
$("#btn-undo").onclick = undo;
$("#btn-redo").onclick = redo;
$("#btn-fit").onclick = fitView;
$("#btn-reset").onclick = () => guard("Reset", async () => {
  const keep = { crop: S.params.crop, mode: S.params.mode, lighting: S.params.lighting };
  const r = await api("levels", { params: { ...keep } });
  S.params = r.params; syncControls(); render(); drawCurve(); commit();
});
$("#btn-export").onclick = () => guard("Export", async () => {
  const r = await api("export", { params: S.params, samples: S.samples, versions: S.versions || [], history: [] });
  status("Exported " + r.path, 8000);
});
$("#file").onchange = (e) => load(e.target.value);

const compare = (on) => { if (S.comparing !== on) { S.comparing = on; render(); } };
$("#btn-compare").addEventListener("mousedown", () => compare(true));
window.addEventListener("mouseup", () => compare(false));

window.addEventListener("keydown", (ev) => {
  if (ev.target.tagName === "INPUT" || ev.target.tagName === "SELECT") return;
  const k = ev.key.toLowerCase();
  if ((ev.metaKey || ev.ctrlKey) && k === "z") { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
  if ((ev.metaKey || ev.ctrlKey) && k === "y") { ev.preventDefault(); redo(); return; }
  if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && k === "c") { ev.preventDefault(); copySettings(); return; }
  if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && k === "v") { ev.preventDefault(); pasteSettings(); return; }
  if ((ev.metaKey || ev.ctrlKey) && (k === "=" || k === "+" || k === "-" || k === "0")) {
    ev.preventDefault();
    if (k === "0") fitView(); else zoomAt(imgCanvas.clientWidth / 2, imgCanvas.clientHeight / 2, k === "-" ? 1 / 1.5 : 1.5);
    return;
  }
  if (ev.metaKey || ev.ctrlKey) return;
  if ((k === "backspace" || k === "delete") && S.hl) { ev.preventDefault(); deleteMark(S.hl); return; }
  if (k === "escape") { closeMenu(); setTool("probe"); return; }
  if (k === "\\") { compare(true); return; }
  if (k === "[") { setWidth(S.width * 0.85); return; }
  if (k === "]") { setWidth(S.width / 0.85); return; }
  if (k === "0") { fitView(); return; }
  const tools = { p: "probe", c: "push", l: "light", n: "neutral", w: "white", k: "black", s: "skin", r: "crop" };
  if (tools[k]) setTool(tools[k]);
});
window.addEventListener("keyup", (ev) => {
  if (ev.key === "\\") compare(false);
});
window.addEventListener("resize", () => { sizeCanvases(); clampView(); drawImage(); });
// keep the browser from zooming the whole page on pinch outside the image
window.addEventListener("wheel", (ev) => { if (ev.ctrlKey) ev.preventDefault(); }, { passive: false });
document.addEventListener("gesturestart", (ev) => ev.preventDefault());

// ---------------------------------------------------------------- start
async function load(name) {
  const d = await api("load", { name });
  S.doc = d; S.params = d.params; S.samples = d.samples || []; S.versions = d.versions || []; S.undo = []; S.redo = []; S.probes = [];
  S.lastCommitted = snapshot();
  $("#file").innerHTML = d.files.map((f) => `<option${f === d.name ? " selected" : ""}>${f}</option>`).join("");
  $("#lighting").innerHTML = d.lighting_options.map((o) => `<option>${o}</option>`).join("");
  location.hash = encodeURIComponent(d.name);
  document.title = d.name + " · filmneg";
  S.view = { scale: 1, cx: 0.5, cy: 0.5 }; detail = null; S.levelHist = null; S.levelHistKey = null;
  syncControls(); setCurve(S.curve); setLevelCh(S.levelCh); renderVersions(); setTool("probe"); renderSamples(); refreshReport();
  status(`${d.name} · ${d.width}×${d.height} · ${d.profile || "no profile, assuming sRGB"}`, 6000);
  render();
}

sizeCanvases();
load(decodeURIComponent(location.hash.slice(1)) || null);
