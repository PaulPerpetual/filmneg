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
  curve: "lightness", // the Curves panel's channel
  zoom: 0.04,         // magnified curve view shows ±zoom (encoded units)
  curveView: "classic", // "classic" (diagonal) or "zoom" (the change, magnified)
  colourZoom: 0.04,
  scopeZoom: 2,       // vectorscope magnification (film is rarely very saturated)   // the Colour by tone panel always shows the change, ±colourZoom
  width: 0.12,        // soft-edit width on the tone axis (push tools and curves)
  readings: [],       // what each point reads now (tone, colour), alongside S.samples
  colourCurve: "warmth", // which curve the Colour by tone panel edits
  sel: null,          // which point the Points panel shows in detail
  showSamples: true,  // the eye in the Points panel
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
  clone: null,        // clone stamp in the Dust tool: {src, off, cursor, stroke}
  cloneR: 12,         // its brush radius, screen px
};

// ---------------------------------------------------------------- server and busy indicator
let busyCount = 0;
function busy(delta) {
  busyCount = Math.max(0, busyCount + delta);
  const el = $("#busy"), on = busyCount > 0 || S.dragging;
  el.className = on ? "busy" : "idle";
  el.querySelector("span").textContent = on ? "Working…" : "Up to date";
  if (on && !busy.poll) busy.poll = setTimeout(pollProgress, 400);
}

// Long tasks (finding dust, repairing many spots, export) report how far they are:
// a filling pie with the task's name replaces the dot.
async function pollProgress() {
  busy.poll = null;
  if (busyCount === 0) return;
  let pr = null;
  try { pr = await (await fetch("/api/progress")).json(); } catch (e) { /* ignore */ }
  const el = $("#busy");
  if (pr && busyCount > 0) {
    const a = 2 * Math.PI * Math.max(0.02, Math.min(0.999, pr.frac)), x = 10 + 8.5 * Math.sin(a), y = 10 - 8.5 * Math.cos(a);
    el.querySelector(".pie path").setAttribute("d", `M10 10V1.5A8.5 8.5 0 ${a > Math.PI ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}Z`);
    el.classList.add("task");
    el.querySelector("span").textContent = `${pr.label} ${Math.round(pr.frac * 100)}%`;
  } else el.classList.remove("task");
  if (busyCount > 0) busy.poll = setTimeout(pollProgress, 300);
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
  exposure: "Exposure", contrast: "Contrast", angle: "Rotation", distortion: "Lens distortion", shoulder: "Highlight roll-off", toe: "Shadow roll-off", saturation: "Saturation", nr: "Colour noise", light: "White balance",
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

// Panels switched off for a moment: their adjustments are left out of the view only.
const OFF = new Set();
function viewParams() {
  const p = clone(S.params);
  if (S.tool === "crop") p.crop = [0, 0, 1, 1];
  if (OFF.has("base")) Object.assign(p, SLIDER_DEFAULTS, { slope: [1, 1, 1], offset: [0, 0, 0] });
  if (OFF.has("levels")) for (const L of Object.values(p.levels)) Object.assign(L, { lo: 0, gamma: 1, hi: 1, out_lo: 0, out_hi: 1 });
  for (const n of OFF.has("curves") ? ["lightness", "r", "g", "b"] : []) p.curves[n] = Array(N_CTRL).fill(0);
  for (const n of OFF.has("colour") ? ["warmth", "tint"] : []) p.curves[n] = Array(N_CTRL).fill(0);
  // reviewing dust: the selected spot shows unrepaired until Return shows its repair
  const d = S.tool === "dust" && S.dust && S.dust.spots.find((x) => x.id === S.dustSel);
  if (d && d.on == null) p.dust_peek = S.dustTry === d.id ? { show: [d.id] } : { hide: [d.id] };
  return p;
}
// Revert: a panel's adjustments back to their defaults (one undo step brings them back).
const REVERT = {
  base: ["Base", (p) => { Object.assign(p, SLIDER_DEFAULTS); p.slope = [1, 1, 1]; p.offset = [0, 0, 0]; }],  // (older versions solved into slope/offset)
  levels: ["Levels", (p) => { for (const L of Object.values(p.levels)) Object.assign(L, { lo: 0, gamma: 1, hi: 1, out_lo: 0, out_hi: 1 }); }],
  curves: ["Curves", (p) => { for (const n of ["lightness", "r", "g", "b"]) p.curves[n] = Array(N_CTRL).fill(0); }],
  colour: ["Colour by tone", (p) => { for (const n of ["warmth", "tint"]) p.curves[n] = Array(N_CTRL).fill(0); }],
  light: ["White balance", (p) => { p.light = { warmth: 0, tint: 0, shadows: [0, 0], midtones: [0, 0], highlights: [0, 0] }; }],
  // centres all three (a few rounds, since neighbouring wheels overlap a little)
  scope: ["Colour wheels", () => { for (let k = 0; k < 6; k++) for (const [, , tone] of WHEELS) setWheel(tone, [0, 0], clone(S.params.curves)); }],
};
const REVERT_ICON = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 8.5h8a4 4 0 0 1 0 8H9"/><path d="M8 5 4.5 8.5 8 12"/></svg>';
for (const [k, [name]] of Object.entries(REVERT)) {
  const h3 = ({ light: $("#light-panel"), scope: $("#scope-panel") }[k] || $(`[data-power="${k}"]`).closest(".panel")).querySelector("h3");
  const b = document.createElement("button");
  b.className = "revert"; b.dataset.revert = k; b.innerHTML = REVERT_ICON;
  b.title = `Revert ${name} to its defaults (⌘Z brings it back)`;
  h3.append(b);
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();  // the title click would fold the panel
    REVERT[k][1](S.params);
    syncControls(); render(); drawCurve(); drawLevels(); commit();
    flash("revert", `${name} reverted`);
    if (k === "light" && solvable()) $("#btn-solve").onclick();  // greys follow the light
  });
}
$$("[data-power]").forEach((b) => b.addEventListener("click", (ev) => {
  ev.stopPropagation();  // the title click would fold the panel
  const k = b.dataset.power, off = !OFF.has(k);
  off ? OFF.add(k) : OFF.delete(k);
  b.closest(".panel").classList.toggle("off", off);
  b.setAttribute("aria-checked", String(!off));
  b.title = off ? "Turn this panel back on" : "Turn this panel off for a moment to compare (not saved)";
  render();
}));

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
    if (!S.dragging && !dirty && gen === renderGen) { scheduleDetail(); refreshReadings(); if (S.tool !== "crop" && S.tool !== "dust") ensureSource(); }
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

function sourceKey(p) { return JSON.stringify([S.doc && S.doc.name, p.crop, p.angle, p.distortion, p.nr, S.dustVer]); }

function liveReady() {
  return S.dragging && !S.comparing && S.tool !== "crop" && liveSrc && liveSrc.key === sourceKey(viewParams());
}

async function ensureSource() {
  const key = sourceKey(viewParams());
  if ((liveSrc && liveSrc.key === key) || liveLoading === key) return;
  liveLoading = key;
  try {
    const src = await fetchRGB16("source", viewParams());
    if (liveLoading === key) liveSrc = { key, ...src };
  } catch (e) { console.error(e); }
  if (liveLoading === key) liveLoading = null;
}

async function renderLive() {
  if (liveBusy) { liveDirty = true; return; }
  liveBusy = true; liveDirty = false;
  const gen = renderGen;
  try {
    const lut = await api("lut", { params: viewParams() });
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
  const { w, h, data } = liveSrc, n = lut.n, T = f32(lut.table), Sh = f32(lut.shifts), Li = f32(lut.light), sp = lut.space;
  const N1 = n - 1, sat = OFF.has("base") ? 1 : S.params.saturation, toS = sp.to_srgb.flat();
  const dec = new Float32Array(n);  // encoded (scan space) -> linear
  for (let i = 0; i < n; i++) { const v = i / N1; dec[i] = sp.gamma ? v ** sp.gamma : v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
  const A = sp.lin_to_lms.flat(), B = sp.m2.flat(), Bi = sp.m2_inv.flat(), Ai = sp.lms_to_lin.flat();
  liveCanvas.width = w; liveCanvas.height = h;
  const ctx = liveCanvas.getContext("2d"), im = ctx.createImageData(w, h), o = im.data;
  const q = (v) => (v <= 0 ? 0 : v >= 1 ? N1 : (v * N1 + 0.5) | 0);
  for (let p = 0, j = 0; p < data.length; p += 3, j += 4) {
    let r = T[(data[p] >> 4) * 3], g = T[(data[p + 1] >> 4) * 3 + 1], b = T[(data[p + 2] >> 4) * 3 + 2];
    const t = q(0.2126 * r + 0.7152 * g + 0.0722 * b), dl = Li[t];  // the curve tone; Light: brightness only
    r += dl; g += dl; b += dl;
    const y0 = 0.2126 * r + 0.7152 * g + 0.0722 * b, wm = Sh[t * 2], m = Sh[t * 2 + 1];
    r += wm / 2 + m / 3; g -= 2 * m / 3; b += -wm / 2 + m / 3;
    const dy = y0 - (0.2126 * r + 0.7152 * g + 0.0722 * b);  // colour only: keep brightness
    r += dy; g += dy; b += dy;
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
function scheduleDetail(wait = 180) {
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
  }, wait);
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
  drawScope();
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
const KIND_COLOR = { measure: "#fff", neutral: "#9ad", white: "#fff", black: "#000", skin: "#e9a37a" };

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

  if (S.tool === "dust") { drawDust(ctx); return; }
  if (S.showSamples) S.samples.forEach((s, i) => drawPoint(ctx, s, KIND_COLOR[s.kind], String(i + 1), i));
  if (S.hl) drawHighlight(ctx);
  if (S.brush) drawPoint(ctx, S.brush, KIND_COLOR[S.brush.kind], S.brush.label);

  if (S.push) S.push.kind === "light" ? drawLightBar(ctx) : drawWheel(ctx);
}

// ---- highlighting and deleting marks on the image
// S.hl = {type: "sample"|"probe", i}: the mark under the mouse, or whose row in
// the sidebar the mouse is over. It gets a halo and a small × to delete it.
function markOf(hl) {
  const m = S.samples[hl.i];
  if (!m) return null;
  const p = toScreen(m.x, m.y), rad = radiusPx(m.r || 0);
  const d = Math.max(rad, 10) * 0.72;
  return { p, rad, del: { x: p.x - d - 10, y: p.y - d - 10 } };
}

function drawHighlight(ctx) {
  const m = markOf(S.hl);
  if (!m) return;
  // hovered: a soft white ring and a macOS-style remove badge (grey disc, white ×)
  const r = Math.max(m.rad, 9) + 5;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 1.5; ctx.shadowColor = "rgba(0,0,0,.5)"; ctx.shadowBlur = 3;
  ctx.beginPath(); ctx.arc(m.p.x, m.p.y, r, 0, 7); ctx.stroke();
  ctx.fillStyle = "rgba(72,72,74,.95)"; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1;
  ctx.beginPath(); ctx.arc(m.del.x, m.del.y, 8.5, 0, 7); ctx.fill();
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.strokeStyle = "rgba(255,255,255,.25)"; ctx.lineWidth = 1; ctx.stroke();
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.6; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(m.del.x - 3, m.del.y - 3); ctx.lineTo(m.del.x + 3, m.del.y + 3);
  ctx.moveTo(m.del.x + 3, m.del.y - 3); ctx.lineTo(m.del.x - 3, m.del.y + 3); ctx.stroke();
  ctx.restore();
}

// Which visible mark is under screen point (x, y), if any.
function markAt(x, y) {
  const near = (m) => m && Math.hypot(m.p.x - x, m.p.y - y) < Math.max(m.rad, 9);
  if (S.showSamples) for (let i = S.samples.length - 1; i >= 0; i--) if (near(markOf({ type: "sample", i }))) return { type: "sample", i };
  return null;
}

function setHighlight(hl) {
  const same = (a, b) => (a && b ? a.type === b.type && a.i === b.i : a === b);
  if (same(hl, S.hl)) return;
  S.hl = hl;
  $$("#samples li").forEach((li) => li.classList.toggle("hl", !!hl && li.dataset.type === hl.type && +li.dataset.i === hl.i));
  drawOverlay();
}

function deleteMark(hl) {
  S.samples.splice(hl.i, 1); S.sel = null; commit(); renderPoints(); drawCurve();
  S.hl = null; drawOverlay();
}

// Points are drawn quietly, like the colour samplers in macOS apps: a thin white
// ring with a soft shadow (no hard outline), and a small translucent label pill
// with the number. A sample's role shows as a little coloured dot in the pill;
// measure-only points have none. The selected point gets the system accent.
const SYS_FONT = '600 10px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';
function drawPoint(ctx, s, color, label, i) {
  const p = toScreen(s.x, s.y), rad = radiusPx(s.r || 0), sel = i != null && i === selPoint();
  const measure = s.kind === "measure";
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowBlur = 2.5;
  ctx.strokeStyle = sel ? "#fff" : "rgba(255,255,255,.85)"; ctx.lineWidth = sel ? 1.5 : 1;
  const r = rad < 4 ? 5 : rad;
  ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.stroke();
  if (rad < 4) { ctx.beginPath(); ctx.arc(p.x, p.y, 0.9, 0, 7); ctx.fillStyle = "#fff"; ctx.fill(); }
  if (label) {
    ctx.font = SYS_FONT;
    const tw = ctx.measureText(label).width, dot = measure ? 0 : 9, h = 15, w = tw + 10 + dot;
    const d = r * 0.71, bx = p.x + d + 3, by = p.y - d - 3 - h;
    ctx.shadowBlur = 3; ctx.shadowOffsetY = 0.5;
    ctx.fillStyle = sel ? "rgba(10,132,255,.92)" : "rgba(28,28,30,.72)";
    ctx.beginPath(); ctx.roundRect(bx, by, w, h, h / 2); ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.strokeStyle = "rgba(255,255,255,.18)"; ctx.lineWidth = 0.5; ctx.stroke();
    if (dot) {
      ctx.fillStyle = color === "#000" ? "#1c1c1e" : color;
      ctx.beginPath(); ctx.arc(bx + 7.5, by + h / 2, 3, 0, 7); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.6)"; ctx.lineWidth = 0.75; ctx.stroke();
    }
    ctx.fillStyle = "#fff"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(label, bx + 5 + dot, by + h / 2 + 0.5);
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
  if (tool === "dust") {  // ⌥ picks a clone source; with one, painting clones; a circle switches that spot; elsewhere marks a new one
    if (ev.altKey && p.inside) { S.clone = { src: { x: p.x, y: p.y }, off: null, cursor: p }; hint("clone source set: paint over the spot. Esc drops it"); drawOverlay(); return; }
    if (S.clone && p.inside) {
      if (!S.clone.off) S.clone.off = { x: S.clone.src.x - p.x, y: S.clone.src.y - p.y };  // aligned from now on
      S.clone.stroke = [{ sx: ev.offsetX, sy: ev.offsetY, x: p.x, y: p.y }]; drawOverlay(); return;
    }
    const hit = !S.dustSel && dustAt(ev.offsetX, ev.offsetY);
    if (hit) { S.dustSel = hit.id; switchDust(hit); return; }
    if (p.inside) S.dustMark = { sx: ev.offsetX, sy: ev.offsetY, x: p.x, y: p.y, r: 0 };
    return;
  }
  if (S.hl && !S.dropper) {  // the × next to a highlighted mark
    const m = markOf(S.hl);
    if (m && Math.hypot(m.del.x - ev.offsetX, m.del.y - ev.offsetY) < 10) { deleteMark(S.hl); return; }
    if (tool !== "crop" && S.hl) {  // a click removes the mark, a drag moves it, whatever the tool
      const t = S.samples[S.hl.i];
      S.sel = S.hl.i; renderPoints(); drawCurve();
      S.sampleMove = { i: S.hl.i, sx: ev.clientX, sy: ev.clientY, x: t.x, y: t.y, moved: false, hovered: true };
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
    const hit = S.samples.findIndex((s) => Math.hypot(toScreen(s.x, s.y).x - ev.offsetX, toScreen(s.x, s.y).y - ev.offsetY) < Math.max(radiusPx(s.r || 0), 8));
    if (hit >= 0 && !S.dropper) { S.sel = hit; renderPoints(); S.sampleMove = { i: hit, sx: ev.clientX, sy: ev.clientY, x: S.samples[hit].x, y: S.samples[hit].y, moved: false }; return; }
    // a click takes one point; dragging grows a circle from the click
    S.brush = { kind: tool === "probe" ? "measure" : tool, x: p.x, y: p.y, r: 0, sx: ev.clientX, sy: ev.clientY,
                label: String(S.samples.length + 1) };
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
    if (tool === "light") setCurve("lightness");  // colour shifts show in the Colour by tone panel
    const pr = await api("probe", { params: S.params, at });
    if (S.push) { S.push.tone = pr.ctone; applyPush(ev.altKey); }
  }
});

overlay.addEventListener("mousemove", (ev) => {
  if (S.dustMark) { S.dustMark.r = Math.hypot(ev.offsetX - S.dustMark.sx, ev.offsetY - S.dustMark.sy); drawOverlay(); return; }
  if (S.tool === "dust" && S.clone) {
    const p = toScan(ev), C = S.clone;
    C.cursor = p; overlay.style.cursor = "crosshair";
    const last = C.stroke && C.stroke[C.stroke.length - 1];
    if (last && Math.hypot(ev.offsetX - last.sx, ev.offsetY - last.sy) > S.cloneR / 3) C.stroke.push({ sx: ev.offsetX, sy: ev.offsetY, x: p.x, y: p.y });
    drawOverlay(); return;
  }
  if (S.brush || S.sampleMove || S.push || S.cropStart || S.pan || S.rotDrag || ev.buttons) return;
  if (S.tool === "dust") { overlay.style.cursor = dustAt(ev.offsetX, ev.offsetY) ? "pointer" : "crosshair"; return; }
  if (S.tool === "crop") {
    const hit = !S.leveling && cropHit(ev.offsetX, ev.offsetY);
    const p = toScan(ev), c = S.params.crop;
    const ex = p.x < c[0] || p.x > c[2], ey = p.y < c[1] || p.y > c[3];
    const outside = ex && ey ? ((p.x < c[0]) === (p.y < c[1]) ? "nwse-resize" : "nesw-resize") : ex ? "ew-resize" : "ns-resize";
    overlay.style.cursor = S.leveling ? "crosshair" : hit ? hit.cursor : p.inside ? outside : ROTATE_CURSOR;
    return;
  }
  const m = S.hl && markOf(S.hl), onDel = m && Math.hypot(m.del.x - ev.offsetX, m.del.y - ev.offsetY) < 10;
  if (!onDel) setHighlight(S.dropper ? null : markAt(ev.offsetX, ev.offsetY));  // an eyedropper samples through points
  if (S.hl) hint("click to remove · drag to move");
  else if (hint.last === "click to remove · drag to move") hint("");
  overlay.style.cursor = onDel || S.hl ? "pointer" : S.tool === "push" ? "move" : S.tool === "light" ? "ns-resize" : "crosshair";
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
    if (!M.moved && Math.hypot(ev.clientX - M.sx, ev.clientY - M.sy) < 3) return;  // still a click (removes it)
    M.moved = true;
    const target = S.samples[M.i];
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
    P.tint = tint; P.warm = warm;  // for the bell in Colour by tone
    S.params.curves.warmth = addTo(P.base.warmth, bump(P.tone, warm, S.width));
    S.params.curves.tint = addTo(P.base.tint, bump(P.tone, tint, S.width));
    hint(`colour at tone ${(P.tone * 100).toFixed(0)}%: warmth ${fmt(warm * 255)}, tint ${fmt(tint * 255)} · width ${S.width.toFixed(2)} ([ ]) · ⌥ finer`);
  }
  render(); drawCurve();
}

window.addEventListener("mouseup", () => {
  S.pan = null;
  if (S.clone && S.clone.stroke) {
    const C = S.clone, r = fitRect(), c = shownBox(), W = S.doc.width, H = S.doc.height, p0 = C.stroke[0];
    const pts = C.stroke.map((q) => [q.x, q.y]);
    C.stroke = null;
    dustCall("dust", { clone: { points: pts, r: S.cloneR * (c[2] - c[0]) * W / (Math.max(W, H) * r.w), src: [p0.x + C.off.x, p0.y + C.off.y] } });
  }
  if (S.dustMark) {
    const M = S.dustMark, r = fitRect(), c = shownBox(), W = S.doc.width, H = S.doc.height;
    S.dustMark = null;
    const px = Math.max(5, M.r);  // a click marks a small spot
    dustCall("dust", { add: { x: M.x, y: M.y, r: px * (c[2] - c[0]) * W / (Math.max(W, H) * r.w) } });
  }
  if (S.brush) {
    const { kind, x, y, r } = S.brush;
    S.brush = null; hint("");
    addPoint({ kind, x, y, r });
  }
  if (S.sampleMove) {
    const M = S.sampleMove;
    S.sampleMove = null;
    if (M.moved) commit();
    else if (M.hovered) deleteMark({ type: "sample", i: M.i });  // a plain click removes it
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

// ---------------------------------------------------------------- points
// One list of points on the image. Each has a role: just measured, or a Grey /
// White / Black / Skin sample that Solve makes right. Any of them can also get
// an Adams zone (under Curves, Light), which only the Light curve serves.
// Readings update after every edit.
const ROLES = { measure: "Measure only", neutral: "Grey", white: "White", black: "Black", skin: "Skin" };
const ZONE_NAMES = ["0", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
let ZONES = [];
const selPoint = () => (S.samples.length ? clamp(S.sel ?? S.samples.length - 1, 0, S.samples.length - 1) : null);
const solvable = () => S.samples.some((s) => s.kind !== "measure");

function addPoint(s) {
  S.samples.push(s); S.sel = S.samples.length - 1;
  commit(); renderPoints(); drawOverlay();
  if (S.dropper) $("#btn-solve").onclick();
}

function refreshReadings() {
  clearTimeout(refreshReadings.t);
  if (!S.samples.length) { S.readings = []; return; }
  refreshReadings.t = setTimeout(async () => {
    try {
      const r = await api("probes", { params: S.params, at: S.samples.map(({ x, y, r }) => ({ x, y, r })) });
      S.readings = r.probes; renderPoints(); drawCurve();
    } catch (e) { console.error(e); }
  }, 150);
}

function hint(t) { hint.last = t; $("#hint").textContent = t; }
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

// A row's short status: how far a sample still is from right, or what a measured point reads.
function pointStatus(s, i) {
  const q = S.readings[i], r = S.report[i];
  const parts = [];
  if (q) parts.push(`${(q.tone * 100).toFixed(0)}%`);
  if (s.zone != null) parts.push(q && Math.abs(q.tone * 10 - s.zone) > 0.5 ? `wants zone ${ZONE_NAMES[s.zone]}` : `zone ${ZONE_NAMES[s.zone]}`);
  let bad = false;
  if (s.kind === "skin" && r) { parts.push(`hue ${fmt(r.hue_off, 0)}°`); bad = Math.abs(r.hue_off) > 8; }
  else if (s.kind !== "measure" && r) { parts.push(Math.hypot(r.da, r.db) < 4 ? "right" : `off ${fmt(r.db, 0)} / ${fmt(r.da, 0)}`); bad = Math.hypot(r.da, r.db) > 4; }
  else if (q) { const c = castNow(q); parts.push(castWords(c.tint / 1000, c.warmth / 1000).replace(/ \(.*\)/, "")); }
  return { text: parts.join(" · "), bad };
}

function renderPoints() {
  renderCasts();
  const ul = $("#samples"), sel = selPoint();
  $("#samples-empty").hidden = S.samples.length > 0;
  $("#points-actions").hidden = !S.samples.length;
  ul.innerHTML = S.samples.map((s, i) => {
    const st = pointStatus(s, i);
    return `<li data-type="sample" data-i="${i}" class="${i === sel ? "sel" : ""}">
      <span class="dot${s.kind === "measure" ? " sq" : ""}" style="background:${KIND_COLOR[s.kind]}"></span><span class="pn">${i + 1}</span>
      <span class="role">${ROLES[s.kind]}</span><span class="res${st.bad ? " bad" : ""}">${st.text}</span><button title="Remove">×</button></li>`;
  }).join("");
  ul.querySelectorAll("li").forEach((li) => {
    const i = +li.dataset.i;
    li.onclick = () => { S.sel = i; renderPoints(); drawCurve(); drawOverlay(); };
    li.onmouseenter = () => setHighlight({ type: "sample", i });
    li.onmouseleave = () => setHighlight(null);
    li.querySelector("button").onclick = (e) => { e.stopPropagation(); deleteMark({ type: "sample", i }); };
  });
  $("#btn-solve").disabled = !solvable();
  showPointDetail();
  renderZones();
}

function showPointDetail() {
  const box = $("#point-detail"), i = selPoint(), s = S.samples[i], p = S.readings[i];
  if (s == null) { box.innerHTML = ""; return; }
  const rgb = (v) => v.map((x) => Math.round(x * 255)).join(" / ");
  const skinOff = p && (Math.abs(p.skin_hue_off) < 5 ? "like typical skin" :
    `${Math.abs(p.skin_hue_off).toFixed(0)}° ${p.skin_hue_off > 0 ? "more yellow" : "more red/pink"} than typical skin`);
  const now = castNow(p);
  const fix = s.kind === "skin" ? [["skin", "Pink ↔ yellow", "track-skin", "°", "how far its hue is from typical skin; the middle is typical skin"]]
    : [["warmth", "Blue ↔ yellow", "track-warm mid", "", "its yellow/blue cast; the middle is neutral"],
       ["tint", "Green ↔ magenta", "track-tint", "", "its magenta/green cast; the middle is neutral"]];
  box.innerHTML = `
    <div class="pop-row"><label>Point ${i + 1} is</label><select id="point-role" title="Measure only, or a sample Solve makes right">
      ${Object.entries(ROLES).map(([k, v]) => `<option value="${k}"${k === s.kind ? " selected" : ""}>${v}</option>`).join("")}</select></div>
    ${p ? `<table class="reading">
      <tr><td>Now</td><td>R/G/B ${rgb(p.output)} · ${(p.tone * 100).toFixed(0)}%, about zone ${ZONE_NAMES[Math.round(p.tone * 10)]}</td></tr>
      <tr><td>Colour</td><td>${castWords(now.tint / 1000, now.warmth / 1000)} <span class="muted">(yellow ${fmt(now.warmth, 0)}, magenta ${fmt(now.tint, 0)})</span></td></tr>
      ${s.kind === "skin" || s.kind === "measure" ? `<tr><td>As skin</td><td>${skinOff}</td></tr>` : ""}
      <tr><td>Scanned</td><td class="muted">R/G/B ${rgb(p.input)}</td></tr></table>` : ""}
    <div class="range-title" title="The knob shows where this point is now; the middle is neutral (for skin: typical skin). Drag toward the middle to correct it. This bends the Colour by tone curves around this point's brightness only; width as for Shift colour ([ ])">Correct just here</div>
    ${fix.map(([n, label, cls, unit, what]) => { const R = fixRange(now[n]); return `<div class="slider compact"><label>${label}</label><input data-fix="${n}" class="${cls}" type="range" min="${-R}" max="${R}" step="0.5" value="${now[n].toFixed(1)}"
      title="Where the point is now: ${what}. Drag toward the middle to correct, double-click to make it neutral"><span data-fix-num="${n}" class="num ro">${fmt(now[n], 0)}${unit}</span></div>`; }).join("")}`;
  $("#point-role").onchange = (e) => { s.kind = e.target.value; commit(); renderPoints(); drawOverlay(); };
  wireProbeFix();
}

// ---- zones (Curves, Light): each point can be given the zone it belongs in; the
// Light curve then bends to put it there. Brightness only, colour stays.
function renderZones() {
  const box = $("#zones-box");
  box.hidden = S.curve !== "lightness";
  if (box.hidden) return;
  $("#zones-empty").hidden = S.samples.length > 0;
  const sel = selPoint();
  $("#zones-list").innerHTML = S.samples.map((s, i) => {
    const q = S.readings[i];
    const now = q ? `${(q.tone * 100).toFixed(0)}% · ${ZONE_NAMES[clamp(Math.round(q.tone * 10), 0, 10)]}` : "";
    const off = q && s.zone != null && Math.abs(q.tone * 10 - s.zone) > 0.5;
    return `<li data-i="${i}" class="${i === sel ? "sel" : ""}"><span class="dot${s.kind === "measure" ? " sq" : ""}" style="background:${KIND_COLOR[s.kind]}"></span><span class="pn">${i + 1}</span>
      <span class="res${off ? " bad" : ""}" title="${off ? "Can't get there without bending the curve too far, or other points ask for the opposite" : "Brightness now, and its zone"}">${now}</span>
      <select title="The zone this point belongs in"><option value="">no zone</option>${ZONES.map((z, k) => `<option value="${k}"${s.zone === k ? " selected" : ""}>${z}</option>`).join("")}</select></li>`;
  }).join("");
  $$("#zones-list li").forEach((li) => {
    const i = +li.dataset.i, s = S.samples[i];
    li.onmouseenter = () => setHighlight({ type: "sample", i });
    li.onmouseleave = () => setHighlight(null);
    li.querySelector("select").onchange = (e) => {
      if (e.target.value === "") delete s.zone; else s.zone = +e.target.value;
      S.sel = i; placeZones();
    };
  });
}

const placeZones = () => guard("Zones", async () => {
  if (S.samples.some((s) => s.zone != null)) S.params = (await api("zones", { params: S.params, samples: S.samples })).params;
  syncControls(); render(); drawCurve(); renderPoints(); commit();
});

// ---- "correct just here": a slider per cast axis whose knob shows where the point
// is now (the middle is neutral, for skin: the typical skin hue). Moving it bends the
// Colour by tone curves around the point's brightness to put the point there. The
// server gives, once per grab, the curve change for one unit more yellow / magenta
// (skin: the change onto the skin line), and the slider scales it linearly.
const FIXES = new WeakMap();  // point -> {kind, base curves, delta per axis, f per axis, cast at grab}
const castNow = (p) => {
  if (!p) return { warmth: 0, tint: 0, skin: 0 };
  const [ta, tb] = p.target || [0, 0];
  return { warmth: (p.b - tb) * 1000, tint: (p.a - ta) * 1000, skin: p.skin_hue_off };
};
const fixRange = (v) => Math.max(30, Math.ceil((Math.abs(v) * 1.3) / 10) * 10);
function fixCurves(F) {
  const out = { warmth: [...F.base.warmth], tint: [...F.base.tint] };
  for (const [k, d] of Object.entries(F.delta)) {
    if (d && F.f[k]) for (const n of ["warmth", "tint"]) out[n] = addTo(out[n], d[n].map((v) => v * F.f[k]));
  }
  return out;
}
const fixStillOn = (F) => {
  const c = fixCurves(F), cur = S.params.curves;
  return ["warmth", "tint"].every((n) => c[n].every((v, i) => Math.abs(v - cur[n][i]) < 1e-9));
};
function wireProbeFix() {
  const s = S.samples[selPoint()];
  if (!s) return;
  const kind = s.kind === "skin" ? "skin" : "neutral";
  let ready = null;
  const grab = () => {
    startDrag();
    const F = FIXES.get(s);
    if (F && F.kind === kind && fixStillOn(F)) { ready = Promise.resolve(F); return; }
    const base = { warmth: [...S.params.curves.warmth], tint: [...S.params.curves.tint] };
    ready = api("neutralize", { params: S.params, at: { x: s.x, y: s.y, r: s.r }, kind, sigma: S.width }).then((r) => {
      const F = { kind, base, cast: { warmth: r.cast.warmth * 1000, tint: r.cast.tint * 1000, skin: r.cast.skin },
        delta: kind === "skin" ? { skin: r.full } : { warmth: r.unit_b, tint: r.unit_a }, f: {} };
      FIXES.set(s, F); return F;
    });
  };
  const unit = kind === "skin" ? "°" : "";
  const setTo = async (el, v) => {
    const n = el.dataset.fix;
    if (!ready) grab();
    const F = await ready;
    if (n === "skin") F.f.skin = Math.abs(F.cast.skin) > 0.3 ? 1 - v / F.cast.skin : 0;  // the change is linear in the hue
    else F.f[n] = (v - F.cast[n]) / 10;  // the deltas are for 10 units (0.01 in Oklab)
    Object.assign(S.params.curves, fixCurves(F));
    $(`[data-fix-num="${n}"]`).textContent = fmt(v, 0) + unit;
    render(); drawCurve();
  };
  // the curves don't answer quite linearly for big moves: on letting go, measure
  // again from where it landed and step the rest of the way (twice at most)
  const settle = async (el, v) => {
    for (let k = 0; k < 2; k++) {
      ready = null; grab();
      const F = await ready, n = el.dataset.fix;
      if (Math.abs(F.cast[n] - v) < 1) break;
      await setTo(el, v);
    }
    ready = null; commit(); endDrag();
  };
  $$("[data-fix]").forEach((el) => {
    el.addEventListener("pointerdown", grab);
    el.addEventListener("input", () => setTo(el, +el.value));
    el.addEventListener("change", () => guard("Correct", () => settle(el, +el.value)));
    el.addEventListener("dblclick", () => guard("Correct", async () => { el.value = 0; grab(); await setTo(el, 0); await settle(el, 0); }));
  });
}

function renderCasts() {
  const C = S.casts, box = $("#casts");
  $("#casts-head").hidden = !C;
  if (!C) { box.innerHTML = ""; return; }
  // one short line per band; where the judgement comes from is in the tooltip
  box.innerHTML = C.lines.map((l) =>
    `<div class="cast-line${l.cast ? " has-cast" : ""}" title="${l.src || ""}"><b>${l.band}</b> ${l.text}</div>`).join("")
    + `<div class="cast-summary muted small">${C.summary}</div>`;
}

async function refreshReport() {
  refreshReadings();
  clearTimeout(refreshReport.t);
  refreshReport.t = setTimeout(async () => {
    try { const r = await api("report", { params: S.params, samples: S.samples }); S.report = r.report; S.casts = r.casts; renderPoints(); }
    catch (e) { console.error(e); }
  }, 300);
}

// ---------------------------------------------------------------- dust
// The server finds spots, ranks them by how likely they are dust and repairs the
// chosen ones in the scan itself; here they are listed, shown and switched.
const DUST_MIN = 0.1;  // less likely spots are left out of the list
const dustInSize = (d) => d.kind === "manual" || d.kind === "clone" || !S.dust.size || (d.px >= S.dust.size[0] && d.px <= S.dust.size[1]);
const dustShown = () => (S.dust ? S.dust.spots.filter((d) => d.on != null || (d.conf >= DUST_MIN && dustInSize(d))) : []);

async function dustCall(route, body = {}) {
  try {
    S.dust = await api(route, { params: S.params, ...body });
    S.dustVer = (S.dustVer || 0) + 1;
    renderDust(); drawOverlay();
    // reviewing (zoomed in on a spot): only the detail shows, so only that is fetched again
    if (S.dustSel && S.view.scale >= 1.3) peekView(); else render();
  } catch (e) { status("dust: " + e.message, 8000); }
}

function switchDust(d) { dustCall("dust", { id: d.id, on: !d.healed }); }

function dustAt(x, y) {
  let best = null;
  for (const d of dustShown()) {
    const p = toScreen(d.x, d.y), dist = Math.hypot(p.x - x, p.y - y);
    if (dist <= Math.max(6, radiusPx(d.r) + 4) && (!best || dist < best.dist)) best = { d, dist };
  }
  return best && best.d;
}

// The list in review order: spots not yet decided (most likely dust first), then
// the ones you repaired, then the ones you left alone.
function dustOrder() {
  const thr = S.dust ? S.dust.threshold : 0.6, how = $("#dust-sort").value;
  const key = { unsure: (d) => Math.abs(d.conf - thr), likely: (d) => -d.conf, unlikely: (d) => d.conf }[how];
  const shown = dustShown();
  return [shown.filter((d) => d.on == null).sort((a, b) => key(a) - key(b)),
          shown.filter((d) => d.on === true).sort((a, b) => b.conf - a.conf),
          shown.filter((d) => d.on === false).sort((a, b) => b.conf - a.conf)];
}

function drawDust(ctx) {
  const sel = S.dust && S.dust.spots.find((d) => d.id === S.dustSel);
  if (!sel) {  // overview: a circle per spot; once you review one, only that one is marked
    for (const d of dustShown()) {
      const p = toScreen(d.x, d.y), rad = Math.max(5, radiusPx(d.r) + 3);
      ctx.setLineDash(d.healed ? [] : [3, 3]);
      for (const [c, w] of [["rgba(0,0,0,.6)", 3], [d.healed ? "#6c6" : "#e9b44c", 1.3]]) {
        ctx.strokeStyle = c; ctx.lineWidth = w; ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 7); ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  } else {
    // the selected spot: everything else dims, brackets frame it
    const p = toScreen(sel.x, sel.y), k = radiusPx(1);  // screen px per unit of view fraction
    const bw = Math.max(sel.bw * k, 4), bh = Math.max(sel.bh * k, 4), R = Math.max(bw, bh) / 2 + 14;
    const trying = S.dustTry === sel.id, shownRepaired = sel.on == null ? trying : sel.healed;
    ctx.fillStyle = "rgba(0,0,0,.28)";
    ctx.beginPath(); ctx.rect(0, 0, overlay.clientWidth, overlay.clientHeight); ctx.arc(p.x, p.y, R + 50, 0, 7); ctx.fill("evenodd");
    const L = Math.min(10, R * 0.5);
    for (const [c, w] of [["rgba(0,0,0,.7)", 4], [shownRepaired ? "#7d7" : "#fff", 2]]) {
      ctx.strokeStyle = c; ctx.lineWidth = w; ctx.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const x = p.x + sx * R, y = p.y + sy * R;
        ctx.moveTo(x - sx * L, y); ctx.lineTo(x, y); ctx.lineTo(x, y - sy * L);
      }
      ctx.stroke();
    }
    const what = sel.on == null ? (trying ? "repair shown · Return keeps it, ⌫ leaves it" : "Return shows the repair · ⌫ leaves it")
      : sel.on ? "kept" : "left alone";
    ctx.font = "12px -apple-system, sans-serif"; ctx.textAlign = "left"; ctx.fillStyle = "#fff";
    ctx.shadowColor = "#000"; ctx.shadowBlur = 3;
    ctx.fillText(`${Math.round(sel.conf * 100)}% · ${what}`, p.x + R + 10, p.y - R - 4);
    ctx.shadowBlur = 0;
  }
  drawClone(ctx);
  if (S.dustMark) {
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(S.dustMark.sx, S.dustMark.sy, Math.max(5, S.dustMark.r), 0, 7); ctx.stroke();
  }
}

// ---- clone stamp: ⌥-click picks the source, painting copies from there (aligned)
function drawClone(ctx) {
  const C = S.clone;
  if (!C) return;
  const r = S.cloneR, cur = C.cursor && toScreen(C.cursor.x, C.cursor.y);
  if (cur) {
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(cur.x, cur.y, r, 0, 7); ctx.stroke();
  }
  // the source: where the copy comes from, following the brush once aligned
  const src = C.off ? (C.cursor && toScreen(C.cursor.x + C.off.x, C.cursor.y + C.off.y)) : toScreen(C.src.x, C.src.y);
  if (src) {
    ctx.strokeStyle = "#8cf"; ctx.lineWidth = 1.2; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(src.x, src.y, r, 0, 7); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(src.x - 5, src.y); ctx.lineTo(src.x + 5, src.y); ctx.moveTo(src.x, src.y - 5); ctx.lineTo(src.x, src.y + 5); ctx.stroke();
  }
  if (C.stroke) {
    ctx.fillStyle = "rgba(140,200,255,.25)";
    for (const q of C.stroke) { ctx.beginPath(); ctx.arc(q.sx, q.sy, r, 0, 7); ctx.fill(); }
  }
}

function renderDust() {
  const D = S.dust, list = $("#dust-list");
  if (!D) return;
  $("#dust-threshold").value = D.threshold;
  $("#dust-threshold-num").textContent = Math.round(D.threshold * 100) + "%";
  $("#dust-repair").checked = D.repair;
  if (document.activeElement !== $("#dust-min")) $("#dust-min").value = D.size[0];
  if (document.activeElement !== $("#dust-max")) $("#dust-max").value = D.size[1];
  const [todo, fixed, left] = dustOrder();
  const healed = dustShown().filter((d) => d.healed).length;
  $("#dust-count").textContent = D.spots.length ? `${healed} repaired · ${todo.length} to review` : "nothing searched yet";
  const name = (d) => ({ manual: "Marked by hand", clone: "Clone stroke", hair: "Hair" }[d.kind] || "Speck");
  const row = (d) => `<div class="row-d${d.id === S.dustSel ? " sel" : ""}${d.on != null ? " done" : ""}" data-id="${d.id}">
    <span class="st${d.healed ? " on" : ""}" title="${d.healed ? "Repaired" : "Not repaired"}"></span>
    <span>${name(d)}</span><span class="px">${d.px} px</span><span class="pct">${d.kind === "clone" || d.kind === "manual" ? "" : Math.round(d.conf * 100) + "%"}</span></div>`;
  const sec = (title, ds) => (ds.length ? `<div class="sec">${title} (${ds.length})</div>` + ds.map(row).join("") : "");
  list.innerHTML = sec("To review", todo) + sec("Kept", fixed) + sec("Left alone", left);
  const sel = list.querySelector(".sel");
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

function zoomToDust(d) {
  S.dustSel = d.id;
  const c = shownBox();
  // zoom so the spot shows at about 60 px, whatever its size
  const now = radiusPx(Math.max(d.bw || 0, d.bh || 0, 1e-4));
  S.view.scale = clamp(S.view.scale * 60 / now, 3, 16);
  S.view.cx = (d.x - c[0]) / (c[2] - c[0]); S.view.cy = (d.y - c[1]) / (c[3] - c[1]);
  clampView(); S.dustTry = null; renderDust(); peekView();
}

// Reviewing a spot changes only the zoomed-in detail (the whole-picture render
// ignores the peek), so fetch just that, at once, and keep the last detail on
// screen meanwhile instead of dropping back to the blurry preview.
function peekView() {
  renderGen++;
  if (detail) detail.gen = renderGen;
  drawImage(); scheduleDetail(60);  // short wait: holding an arrow key still sends one request
}

// Decide a spot and move on to the next one still to review.
async function decideDust(d, on) {
  const todo = dustOrder()[0], i = todo.findIndex((x) => x.id === d.id);
  const next = todo[i + 1] || todo[i - 1];
  S.dustTry = null;
  d.on = on; d.healed = on;  // shown at once; the server's answer (with relearned scores) follows
  if (next) zoomToDust(next); else renderDust();
  await dustCall("dust", { id: d.id, on });
}

// ↑/↓ walk the list; Enter repairs the selected spot and moves on, Backspace leaves
// it alone and moves on (or removes a spot you marked), Space just switches it.
function dustKey(ev) {
  const all = dustOrder().flat();
  const i = all.findIndex((d) => d.id === S.dustSel), d = all[i];
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    const n = all[i < 0 ? 0 : clamp(i + (ev.key === "ArrowDown" ? 1 : -1), 0, all.length - 1)];
    if (n) zoomToDust(n);
    return true;
  }
  if (!d) return false;
  if (ev.key === "Enter") {  // first Return shows the repair, the second keeps it
    ev.preventDefault();
    if (d.on == null && S.dustTry !== d.id) { S.dustTry = d.id; peekView(); } else decideDust(d, true);
    return true;
  }
  if (ev.key === "Backspace" || ev.key === "Delete") {
    ev.preventDefault();
    if (d.kind === "manual") dustCall("dust", { remove: d.id }); else decideDust(d, false);
    return true;
  }
  if (ev.key === " ") { ev.preventDefault(); switchDust(d); return true; }
  if (ev.key === "[" || ev.key === "]") { S.cloneR = clamp(S.cloneR * (ev.key === "]" ? 1.25 : 0.8), 3, 200); drawOverlay(); return true; }
  return false;
}

$("#dust-list").addEventListener("click", (ev) => {
  const r = ev.target.closest(".row-d");
  if (!r) return;
  const d = S.dust.spots.find((x) => x.id === +r.dataset.id);
  if (ev.target.classList.contains("st")) { S.dustSel = d.id; switchDust(d); } else zoomToDust(d);
});
$("#dust-find").onclick = () => guard("Find dust", async () => { await dustCall("dust_find"); status(`${S.dust.spots.filter((d) => d.healed).length} spots repaired`); });
$("#dust-threshold").addEventListener("input", (e) => { $("#dust-threshold-num").textContent = Math.round(e.target.value * 100) + "%"; });
$("#dust-threshold").addEventListener("change", (e) => dustCall("dust", { threshold: +e.target.value }));
$("#dust-repair").onchange = (e) => dustCall("dust", { repair: e.target.checked });
$("#dust-mask").onclick = () => guard("Export mask", async () => status("Saved " + (await api("dust_mask", { params: S.params })).path, 6000));
$("#dust-done").onclick = () => setTool("probe");
$("#dust-sort").onchange = () => renderDust();
for (const id of ["#dust-min", "#dust-max"]) {
  const el = $(id);
  const apply = () => { const a = parseInt($("#dust-min").value, 10), b = parseInt($("#dust-max").value, 10); if (a > 0 && b > a) dustCall("dust", { size: [a, b] }); };
  el.addEventListener("keydown", (ev) => {
    const step = { ArrowUp: 1, ArrowDown: -1 }[ev.key];
    if (step) { ev.preventDefault(); el.value = Math.max(1, (parseInt(el.value, 10) || 0) + step * (ev.shiftKey ? 10 : 1)); clearTimeout(el.t); el.t = setTimeout(apply, 400); }
    if (ev.key === "Enter") { apply(); el.blur(); }
  });
  el.addEventListener("change", apply);
}

// ---------------------------------------------------------------- vectorscope and colour wheels
// The vectorscope plots every pixel's colour (Rec. 709 Cb/Cr, like DaVinci's):
// the angle is the hue, the distance from the centre the saturation. Faint
// colours behind it show which way is which. The three wheels below are a
// classic colour balance for shadows, midtones and highlights; they are another
// handle on the Colour by tone curves: the puck shows the curves' warmth and
// tint at that brightness, dragging it bends them there.
const scopeCanvas = $("#scope");
const WHEELS = [["shadows", "Shadows", 0.15], ["midtones", "Midtones", 0.5], ["highlights", "Highlights", 0.85]];
const WHEEL_RANGE = 0.08;   // a puck at the rim: ±20 (in 0..255 steps) of warmth or tint
const WHEEL_SIGMA = 0.2;    // how far along the tones a wheel reaches

// RGB (0..1) -> Cb, Cr (Rec. 709); and back at a given luma, for the background colours
const cbcr = (r, g, b) => [-0.1146 * r - 0.3854 * g + 0.5 * b, 0.5 * r - 0.4542 * g - 0.0458 * b];
const fromCbcr = (y, cb, cr) => [y + 1.5748 * cr, y - 0.1873 * cb - 0.4681 * cr, y + 1.8556 * cb];
// what a warmth / tint push does on the scope (mirrors render_pixels: brightness kept)
const pushDir = (dr, dg, db) => { const y = 0.2126 * dr + 0.7152 * dg + 0.0722 * db; return cbcr(dr - y, dg - y, db - y); };
const WARM_DIR = pushDir(0.5, 0, -0.5), TINT_DIR = pushDir(1 / 3, -2 / 3, 1 / 3);

// A faint hue disc (cached per size): the background of the scope and the wheels.
function hueDisc(size, alpha) {
  hueDisc.c = hueDisc.c || {};
  const key = size + ":" + alpha;
  if (hueDisc.c[key]) return hueDisc.c[key];
  const c = document.createElement("canvas"); c.width = c.height = size;
  const ctx = c.getContext("2d"), im = ctx.createImageData(size, size), R = size / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x + 0.5 - R) / R, dy = (R - y - 0.5) / R, d = Math.hypot(dx, dy);
    if (d > 1) continue;
    const rgb = fromCbcr(0.5, dx * 0.3, dy * 0.3), i = (y * size + x) * 4;
    im.data.set([...rgb.map((v) => clamp(v, 0, 1) * 255), 255 * alpha * Math.min(1, d * 1.6)], i);
  }
  ctx.putImageData(im, 0, 0);
  return (hueDisc.c[key] = c);
}

function drawScope() {
  if (!scopeCanvas || !previewPx || $("#scope-panel").classList.contains("collapsed")) return;
  const ctx = scopeCanvas.getContext("2d"), N = scopeCanvas.width, R = N / 2 - 10, cx = N / 2, cy = N / 2;
  const k = R / 0.5 * S.scopeZoom;  // screen px per unit of Cb/Cr
  ctx.clearRect(0, 0, N, N);
  // DaVinci-style: black disc, grey graticule, the pixels glowing in their own colour
  ctx.fillStyle = "#050505"; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fill();
  ctx.drawImage(hueDisc(256, 0.13), cx - R, cy - R, 2 * R, 2 * R);  // which way is which, faintly
  const GRAT = "rgba(150,150,150,.75)";  // graticule
  ctx.strokeStyle = GRAT; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
  for (let a = 0; a < 360; a += 5) {  // ticks round the rim, longer every 10°
    const t = a * Math.PI / 180, l = a % 10 ? 5 : 10;
    ctx.moveTo(cx + Math.cos(t) * R, cy + Math.sin(t) * R); ctx.lineTo(cx + Math.cos(t) * (R - l), cy + Math.sin(t) * (R - l));
  }
  ctx.stroke();
  const skin = cbcr(0.87, 0.64, 0.52), sl = Math.hypot(...skin);
  ctx.strokeStyle = "rgba(200,200,200,.4)";
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + skin[0] / sl * R, cy - skin[1] / sl * R); ctx.stroke();
  ctx.font = "11px -apple-system, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = GRAT;
  for (const [name, rgb] of [["R", [1, 0, 0]], ["Y", [1, 1, 0]], ["G", [0, 1, 0]], ["C", [0, 1, 1]], ["B", [0, 0, 1]], ["M", [1, 0, 1]]]) {
    const [b, r] = cbcr(...rgb.map((v) => v * 0.75)), x = cx + b * k, y = cy - r * k, d = Math.hypot(x - cx, y - cy);
    if (d > R - 16) {  // zoomed in: the target is off the scope, so just name the direction at the rim
      ctx.textAlign = "center"; ctx.fillText(name, cx + (x - cx) / d * (R - 18), cy + (y - cy) / d * (R - 18)); ctx.textAlign = "left";
      continue;
    }
    ctx.beginPath();  // corner brackets
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      ctx.moveTo(x + sx * 9, y + sy * 4); ctx.lineTo(x + sx * 9, y + sy * 9); ctx.lineTo(x + sx * 4, y + sy * 9);
    }
    ctx.stroke(); ctx.fillText(name, x + 11, y + 7);
  }
  // the pixels: density, each cell in the average colour of its pixels
  const G = 192, cnt = new Float32Array(G * G), sum = new Float32Array(G * G * 3), d = previewPx.data;
  let max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const [b, r] = cbcr(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
    const gx = Math.round((b * k / R + 1) * (G - 1) / 2), gy = Math.round((1 - r * k / R) * (G - 1) / 2);
    if (gx < 0 || gy < 0 || gx >= G || gy >= G) continue;
    const j = gy * G + gx, v = ++cnt[j];
    sum[j * 3] += d[i]; sum[j * 3 + 1] += d[i + 1]; sum[j * 3 + 2] += d[i + 2];
    if (v > max) max = v;
  }
  const dots = drawScope.c || (drawScope.c = document.createElement("canvas"));
  dots.width = dots.height = G;
  const dctx = dots.getContext("2d"), im = dctx.createImageData(G, G), lm = Math.log1p(max);
  for (let i = 0; i < G * G; i++) {
    if (!cnt[i]) continue;
    const r = sum[i * 3], g = sum[i * 3 + 1], b = sum[i * 3 + 2], m = Math.max(r, g, b, 1);
    // the colour at full brightness, whitened where it is dense (like light on film)
    const f = Math.log1p(cnt[i]) / lm, w = f * f * 0.6;
    im.data.set([255 * (r / m * (1 - w) + w), 255 * (g / m * (1 - w) + w), 255 * (b / m * (1 - w) + w), 40 + 215 * f], i * 4);
  }
  dctx.putImageData(im, 0, 0);
  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.clip();
  ctx.imageSmoothingEnabled = true; ctx.globalCompositeOperation = "lighter";
  ctx.filter = "blur(4px)"; ctx.globalAlpha = 0.7; ctx.drawImage(dots, cx - R, cy - R, 2 * R, 2 * R);  // glow
  ctx.filter = "none"; ctx.globalAlpha = 1; ctx.drawImage(dots, cx - R, cy - R, 2 * R, 2 * R);
  ctx.restore();
  drawWheels();
}

// ---- colour wheels
const wheelValue = (tone) => [splineAt(S.params.curves.warmth, tone), splineAt(S.params.curves.tint, tone)];
const wheelXY = ([w, t]) => [w * WARM_DIR[0] + t * TINT_DIR[0], w * WARM_DIR[1] + t * TINT_DIR[1]];
function wheelFromXY(x, y) {  // inverse of wheelXY
  const [a, c] = WARM_DIR, [b, d] = TINT_DIR, det = a * d - b * c;
  return [(x * d - b * y) / det, (a * y - c * x) / det];
}
const WHEEL_SCALE = Math.hypot(...wheelXY([WHEEL_RANGE, 0]));  // Cb/Cr at the rim

function drawWheels() {
  if (!S.params) return;
  for (const [key, name, tone] of WHEELS) {
    const c = $(`#wheel-${key}`), ctx = c.getContext("2d"), N = c.width, R = N / 2 - 6, m = N / 2;
    ctx.clearRect(0, 0, N, N);
    ctx.drawImage(hueDisc(128, 0.55), m - R, m - R, 2 * R, 2 * R);
    ctx.strokeStyle = "rgba(255,255,255,.22)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(m, m, R, 0, 7); ctx.moveTo(m - 5, m); ctx.lineTo(m + 5, m); ctx.moveTo(m, m - 5); ctx.lineTo(m, m + 5); ctx.stroke();
    const v = wheelValue(tone), [x, y] = wheelXY(v), px = m + clamp(x / WHEEL_SCALE, -1.2, 1.2) * R, py = m - clamp(y / WHEEL_SCALE, -1.2, 1.2) * R;
    ctx.strokeStyle = "rgba(255,255,255,.5)"; ctx.beginPath(); ctx.moveTo(m, m); ctx.lineTo(px, py); ctx.stroke();
    for (const [col, w] of [["rgba(0,0,0,.7)", 3.5], ["#fff", 1.6]]) {
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); ctx.arc(px, py, 6, 0, 7); ctx.stroke();
    }
    const n = (x) => { const r = Math.round(x * 255); return r ? fmt(r, 0) : "0"; };
    $(`#wheel-${key}-num`).textContent = `${n(v[0])} · ${n(v[1])}`;
  }
}

// Drag a puck: the curves move at that brightness to put it there (relative to
// where you grabbed it, so a click doesn't jump). Double-click centres it.
let wheelDrag = null;
for (const [key, , tone] of WHEELS) {
  const c = $(`#wheel-${key}`);
  const at = (ev) => { const b = c.getBoundingClientRect(), R = b.width / 2 - 6 * b.width / c.width; return [(ev.clientX - b.left - b.width / 2) / R, (b.top + b.height / 2 - ev.clientY) / R]; };
  c.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    wheelDrag = { tone, key, start: at(ev), from: wheelXY(wheelValue(tone)), base: clone(S.params.curves), at, fine: ev.altKey };
    startDrag();
  });
  c.addEventListener("dblclick", () => { setWheel(tone, [0, 0], clone(S.params.curves)); drawWheels(); drawCurve(); render(); commit(); });
}
function setWheel(tone, target, base) {
  const unit = splineAt(bump(tone, 1, WHEEL_SIGMA), tone);
  ["warmth", "tint"].forEach((n, i) => {
    const delta = (target[i] - splineAt(base[n], tone)) / unit;
    S.params.curves[n] = addTo(base[n], bump(tone, delta, WHEEL_SIGMA));
  });
}
window.addEventListener("mousemove", (ev) => {
  const D = wheelDrag;
  if (!D) return;
  if (ev.altKey !== D.fine) { D.fine = ev.altKey; D.start = D.at(ev); D.from = wheelXY(wheelValue(D.tone)); D.base = clone(S.params.curves); }
  const p = D.at(ev), f = WHEEL_SCALE * (D.fine ? 0.2 : 1);
  const x = D.from[0] + (p[0] - D.start[0]) * f, y = D.from[1] + (p[1] - D.start[1]) * f;
  setWheel(D.tone, wheelFromXY(x, y), D.base);
  const v = wheelValue(D.tone);
  hint(`${D.key}: warmth ${fmt(v[0] * 255)}, tint ${fmt(v[1] * 255)} · ⌥ finer · double-click centres`);
  drawWheels(); drawCurve(); render();
});
window.addEventListener("mouseup", () => { if (wheelDrag) { wheelDrag = null; commit(); endDrag(); } });

$("#scope-zoom").onchange = (e) => { S.scopeZoom = +e.target.value; drawScope(); };

// ---------------------------------------------------------------- curve panels
// Two panels share this code: Curves (Light, R, G, B; output over input with the
// diagonal, or the change magnified) and Colour by tone (warmth and tint as a
// function of brightness, always the change alone, magnified).
const TONE = { canvas: $("#curve"), kind: "tone", hover: null };
const COLOUR = { canvas: $("#colour-by-tone"), kind: "colour", hover: null };
const CURVE_PANELS = [TONE, COLOUR];
const CURVE_COLORS = { lightness: "#ddd", r: "#f66", g: "#6d6", b: "#69f", warmth: "#e8c040", tint: "#d070d0" };

const isClassic = (P) => P === TONE && S.curveView === "classic";
const panelZoom = (P) => (P === TONE ? S.zoom : S.colourZoom);
const curveNames = (P) => (P === COLOUR ? ["warmth", "tint"] : [S.curve]);  // drawn
const editNames = (P) => (P === COLOUR ? [S.colourCurve] : [S.curve]);       // editable

function curveGeom(P) {
  const W = P.canvas.width, H = P.canvas.height, pad = 14;
  const classic = isClassic(P), z = panelZoom(P);
  return { W, H, pad, classic, z, x: (t) => pad + t * (W - 2 * pad), t: (px) => (px - pad) / (W - 2 * pad),
           // classic: output over input with the diagonal; otherwise the change alone, magnified
           y: classic ? (o) => H - pad - o * (H - 2 * pad) : (v) => H / 2 - (v / z) * (H / 2 - pad),
           base: classic ? (t) => t : () => 0 };
}

// What colour the image moves towards when each curve goes up (first) or down.
const CURVE_DIRECTIONS = {
  warmth: ["#ffd23c", "#3c78ff"], tint: ["#e040e0", "#40e040"], lightness: ["#ffffff", "#000000"],
  r: ["#ff4040", "#30e0e0"], g: ["#40e040", "#e040e0"], b: ["#4070ff", "#ffe040"],
};

function drawCurve() { CURVE_PANELS.forEach(drawCurvePanel); drawWheels(); }

function drawCurvePanel(P) {
  if (!S.params) return;
  const ctx = P.canvas.getContext("2d"), g = curveGeom(P);
  ctx.clearRect(0, 0, g.W, g.H);

  // background: the colour the image moves towards above and below the line
  const [up, down] = CURVE_DIRECTIONS[editNames(P)[0]];
  const bg = ctx.createLinearGradient(0, 0, 0, g.H);
  bg.addColorStop(0, up); bg.addColorStop(0.5, "rgba(0,0,0,0)"); bg.addColorStop(1, down);
  ctx.globalAlpha = 0.06; ctx.fillStyle = bg; ctx.fillRect(0, 0, g.W, g.H); ctx.globalAlpha = 1;

  // histogram of the current preview behind everything
  if (S.hist) {
    const h = S.hist[P === COLOUR ? "lightness" : S.curve], B = h.length;
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
    for (const v of [-0.75, -0.5, -0.25, 0.25, 0.5, 0.75]) {
      ctx.strokeStyle = "#2f2f2f"; ctx.beginPath(); ctx.moveTo(0, g.y(v * g.z)); ctx.lineTo(g.W, g.y(v * g.z)); ctx.stroke();
    }
    ctx.strokeStyle = "#666"; ctx.beginPath(); ctx.moveTo(0, g.y(0)); ctx.lineTo(g.W, g.y(0)); ctx.stroke();
    ctx.fillStyle = "#666"; ctx.textAlign = "left";
    ctx.fillText(`+${Math.round(g.z * 255)}`, 2, 12); ctx.fillText(`−${Math.round(g.z * 255)}`, 2, g.H - 16);
  }

  // falloff preview: where a drag from here would act and how wide, as a bell
  // that follows the curve itself
  let shown = (S.curveDrag && S.curveDrag.panel === P) ? S.curveDrag : P.hover;
  if (S.push && S.push.tone != null && (P === COLOUR) === (S.push.kind === "colour")) {
    // a shift on the image: its bell, along the curve it bends
    const name = P === COLOUR ? (Math.abs(S.push.tint || 0) > Math.abs(S.push.warm || 0) ? "tint" : "warmth") : "lightness";
    shown = { name, t: S.push.tone, width: S.width };
  }
  if (shown) {
    const ctrl = S.params.curves[shown.name], amp = (g.H / 2 - g.pad) * 0.45;
    ctx.fillStyle = "rgba(255,255,255,.08)";
    for (let px = 0; px < g.W; px += 2) {
      const t = g.t(px), w = Math.exp(-0.5 * ((t - shown.t) / shown.width) ** 2);
      if (w < 0.01 || t < 0 || t > 1) continue;
      const cy = g.y(g.base(t) + splineAt(ctrl, t));
      ctx.fillRect(px, cy - w * amp, 2, 2 * w * amp);
    }
  }

  if (P === COLOUR) {
    ctx.textAlign = "right";
    ctx.fillStyle = CURVE_COLORS.warmth; ctx.fillText("yellow ↑ blue ↓", g.W - 6, 16);
    ctx.fillStyle = CURVE_COLORS.tint; ctx.fillText("magenta ↑ green ↓", g.W - 6, 32);
  }
  for (const name of curveNames(P)) {
    const ctrl = S.params.curves[name];
    const active = editNames(P).includes(name);
    const pts = [];
    for (let i = 0; i <= 200; i++) pts.push([i / 200, splineAt(ctrl, i / 200)]);
    // curvature comb: second difference drawn as hairlines from the curve
    ctx.strokeStyle = CURVE_COLORS[name] + "55"; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 1; i < pts.length - 1 && !g.classic; i += 2) {
      const k = (pts[i - 1][1] - 2 * pts[i][1] + pts[i + 1][1]) * 200 * 200;
      const x = g.x(pts[i][0]), y = g.y(pts[i][1]);
      ctx.moveTo(x, y); ctx.lineTo(x, y + k * 0.01 / g.z * 4);
    }
    ctx.stroke();
    ctx.strokeStyle = CURVE_COLORS[name]; ctx.lineWidth = active ? 2.5 : 1.2; ctx.globalAlpha = active ? 1 : 0.55;
    ctx.beginPath();
    pts.forEach(([t, v], i) => (i ? ctx.lineTo(g.x(t), g.y(g.base(t) + v)) : ctx.moveTo(g.x(t), g.y(g.base(t) + v))));
    ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = CURVE_COLORS[name] + "99";
    if (!g.classic) ctrl.forEach((v, i) => { ctx.beginPath(); ctx.arc(g.x(CTRL_POS[i]), g.y(v), 2, 0, 7); ctx.fill(); });
  }

  // where each point sits on the curve(s): its tone, or its channel value in R/G/B
  // quiet: a thin hairline and a small grey number, the selected point in the accent
  ctx.font = SYS_FONT.replace("10px", "11px"); ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  S.samples.forEach((sm, i) => {
    const q = S.readings[i];
    if (!q) return;
    const t = P === TONE && ["r", "g", "b"].includes(S.curve) ? q.output["rgb".indexOf(S.curve)] : q.ctone;
    const sel = i === selPoint(), col = sel ? "rgba(10,132,255,.95)" : "rgba(235,235,245,.38)";
    const ly = 13 + (i % 3) * 13;  // stagger labels so neighbours stay readable
    ctx.strokeStyle = col; ctx.lineWidth = sel ? 1 : 0.75;
    ctx.beginPath(); ctx.moveTo(g.x(t), ly + 3); ctx.lineTo(g.x(t), g.H); ctx.stroke();
    ctx.fillStyle = sel ? col : "rgba(235,235,245,.6)"; ctx.fillText(String(i + 1), g.x(t), ly);
  });
  if (S.push && S.push.tone != null) {
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(g.x(S.push.tone), 0); ctx.lineTo(g.x(S.push.tone), g.H); ctx.stroke();
  }

  // while dragging: a swatch of the colour you're pushing towards
  if (S.curveDrag && S.curveDrag.panel === P && S.curveDrag.amount) {
    const D = S.curveDrag, [u, d] = CURVE_DIRECTIONS[D.name];
    ctx.fillStyle = D.amount > 0 ? u : d; ctx.strokeStyle = "#888"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(g.x(D.t), g.pad + 12, 9, 0, 7); ctx.fill(); ctx.stroke();
  }
}

// How wide an edit starting at canvas point (px, py) would be: narrow when you
// grab right on the curve, broader the further away from it you press.
function editAt(P, px, py) {
  const g = curveGeom(P), t = clamp(g.t(px), 0, 1);
  let best = null;
  for (const name of editNames(P)) {
    const d = Math.abs(py - g.y(g.base(t) + splineAt(S.params.curves[name], t)));
    if (!best || d < best.d) best = { name, d };
  }
  const near = 12 * P.canvas.width / P.canvas.clientWidth;
  const far = Math.max(0, best.d - near) / (g.H / 2 - g.pad);
  return { name: best.name, t, width: 0.04 + 0.9 * Math.min(far, 1.3) ** 1.5 };
}

const canvasPoint = (P, ev) => {
  const b = P.canvas.getBoundingClientRect(), sc = P.canvas.width / b.width;
  return { x: (ev.clientX - b.left) * sc, y: (ev.clientY - b.top) * sc, sc };
};

// Smooth the shown curve(s), like Rhino's Smooth: each control value moves part of
// the way towards the average of its neighbours. Repeat for more.
function smoothCurves(P) {
  for (const n of editNames(P)) {
    const c = S.params.curves[n];
    S.params.curves[n] = c.map((v, i) => {
      const l = c[Math.max(0, i - 1)], r = c[Math.min(c.length - 1, i + 1)];
      return v + 0.5 * ((l + r) / 2 - v);
    });
  }
  drawCurve(); render(); commit();
}

function resetCurves(P) {
  for (const n of editNames(P)) S.params.curves[n] = Array(N_CTRL).fill(0);
  drawCurve(); render(); commit();
}

for (const P of CURVE_PANELS) {
  P.canvas.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    const p = canvasPoint(P, ev);
    S.curveDrag = { ...editAt(P, p.x, p.y), panel: P, y0: p.y, amount: 0, base: clone(S.params.curves) };
    startDrag(); drawCurvePanel(P);
  });
  P.canvas.addEventListener("mousemove", (ev) => {
    if (S.curveDrag) return;
    const p = canvasPoint(P, ev);
    P.hover = editAt(P, p.x, p.y); drawCurvePanel(P);
  });
  P.canvas.addEventListener("mouseleave", () => { P.hover = null; drawCurvePanel(P); });
  P.canvas.addEventListener("dblclick", () => resetCurves(P));
  const panel = P.canvas.closest(".panel");
  panel.querySelector("[data-act=smooth]").onclick = () => smoothCurves(P);
  panel.querySelector("[data-act=reset]").onclick = () => resetCurves(P);
}

window.addEventListener("mousemove", (ev) => {
  const D = S.curveDrag;
  if (!D) return;
  const p = canvasPoint(D.panel, ev), g = curveGeom(D.panel);
  const gain = ev.altKey ? 0.2 : ev.shiftKey ? 3 : 1;
  D.amount = -(p.y - D.y0) * (g.classic ? 1 : g.z) / (g.H - 2 * g.pad) * gain;
  S.params.curves[D.name] = addTo(D.base[D.name], bump(D.t, D.amount, D.width));
  drawCurvePanel(D.panel); render();
});

window.addEventListener("mouseup", () => {
  if (S.curveDrag) { const P = S.curveDrag.panel; S.curveDrag = null; commit(); endDrag(); drawCurvePanel(P); }
});

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
  for (const k of ["levels", "curves", "saturation", "light"]) delete p[k];
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

// Channel colours as in Pixelmator Pro: the macOS system red, green and blue
// like Pixelmator: a dark tinted fill under a bright outline in the channel's colour
const LEVEL_COLORS = {
  rgb: { fill: "rgba(150,150,155,.32)", line: "rgba(215,215,220,.9)", bar: "#fff" },
  r: { fill: "rgba(232,84,62,.30)", line: "#e8543e", bar: "#ff453a" },
  g: { fill: "rgba(60,190,90,.28)", line: "#3cbe5a", bar: "#30d158" },
  b: { fill: "rgba(40,130,255,.30)", line: "#3a8cff", bar: "#0a84ff" },
};

function drawLevels() {
  if (!S.params) return;
  const ctx = levelsCanvas.getContext("2d"), g = levelGeom(), L = curLevel();
  ctx.clearRect(0, 0, levelsCanvas.width, levelsCanvas.height);

  // histogram: one column per pixel, the average count of the bins it covers
  const H = S.levelHist;
  if (H) {
    // RGB: one plain grey histogram of all three channels together; R, G, B: that channel
    const rgbAll = S.levelCh === "rgb";
    const hists = rgbAll ? [H.hist[0].map((v, i) => (v + H.hist[1][i] + H.hist[2][i]) / 3)] : [H.hist["rgb".indexOf(S.levelCh)]];
    const cols = [];
    for (const h of hists) {
      const col = new Float32Array(g.span);
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
    const LC = LEVEL_COLORS[S.levelCh];
    cols.forEach((col) => {
      const top = (px) => LV_HIST - Math.min(1, col[px] / norm) * (LV_HIST - 8);
      ctx.beginPath(); ctx.moveTo(g.pad, LV_HIST);
      for (let px = 0; px < g.span; px++) ctx.lineTo(g.pad + px + 0.5, top(px));
      ctx.lineTo(g.pad + g.span, LV_HIST); ctx.closePath();
      ctx.fillStyle = LC.fill; ctx.fill();
      ctx.beginPath();
      for (let px = 0; px < g.span; px++) (px ? ctx.lineTo : ctx.moveTo).call(ctx, g.pad + px + 0.5, top(px));
      ctx.strokeStyle = LC.line; ctx.lineWidth = 1.1; ctx.lineJoin = "round"; ctx.stroke();
    });
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

  // dotted guides up from each handle, as in Pixelmator
  ctx.save(); ctx.setLineDash([1.5, 3]); ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 1;
  for (const v of [L.lo, midPos(L), L.hi]) {
    const x = g.x(v);
    if (x >= g.pad && x <= g.pad + g.span) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, LV_HIST); ctx.stroke(); }
  }
  ctx.restore();

  // input ramp and handles
  const ramp = (x0, x1, y) => {
    const gr = ctx.createLinearGradient(x0, 0, x1, 0);
    gr.addColorStop(0, "#000"); gr.addColorStop(1, S.levelCh === "rgb" ? "#fff" : LEVEL_COLORS[S.levelCh].bar);
    ctx.fillStyle = gr; ctx.fillRect(g.pad, y, g.span, 5);
  };
  ramp(g.x(0), g.x(1), g.inY + 3);
  const tri = (x, y, fill) => {
    ctx.fillStyle = fill; ctx.strokeStyle = fill === "#fff" ? "rgba(0,0,0,.35)" : "rgba(255,255,255,.28)"; ctx.lineWidth = 1;
    if (x < g.pad - 9 || x > g.pad + g.span + 9) {  // zoomed past it: a small arrow at the edge points to it
      const e = x < g.pad ? 2 : g.W - 2, d = x < g.pad ? 1 : -1;
      ctx.beginPath(); ctx.moveTo(e, y + 14); ctx.lineTo(e + 9 * d, y + 8); ctx.lineTo(e + 9 * d, y + 20); ctx.closePath(); ctx.fill(); ctx.stroke();
      return;
    }
    // a little house with soft corners and a shadow, like Pixelmator's level handles
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,.5)"; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1;
    ctx.beginPath(); ctx.moveTo(x, y + 5);
    ctx.lineTo(x + 8, y + 12); ctx.lineTo(x + 8, y + 20); ctx.quadraticCurveTo(x + 8, y + 23, x + 5, y + 23);
    ctx.lineTo(x - 5, y + 23); ctx.quadraticCurveTo(x - 8, y + 23, x - 8, y + 20); ctx.lineTo(x - 8, y + 12); ctx.closePath();
    ctx.fill(); ctx.restore(); ctx.stroke();
  };
  tri(g.x(L.lo), g.inY, "#3a3a3c"); tri(g.x(midPos(L)), g.inY, "#a1a1a6"); tri(g.x(L.hi), g.inY, "#fff");

  // output ramp and handles (always the whole range)
  ramp(g.ox(0), g.ox(1), g.outY + 3);
  tri(g.ox(L.out_lo), g.outY, "#3a3a3c"); tri(g.ox(L.out_hi), g.outY, "#fff");

  // numbers and clipping
  const set = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v; };
  set("#lv-lo", Math.round(L.lo * 255)); set("#lv-hi", Math.round(L.hi * 255)); set("#lv-gamma", L.gamma.toFixed(2));
  set("#lv-out-lo", Math.round(L.out_lo * 255)); set("#lv-out-hi", Math.round(L.out_hi * 255));
  const c = levelClipping(), pct = (f) => (f < 0.0005 ? "none" : f < 0.01 ? (f * 100).toFixed(2) + "%" : (f * 100).toFixed(1) + "%");
  $("#lv-clip").textContent = c ? `Clipped to black: ${pct(c.lo)} · to white: ${pct(c.hi)}` : "";
}

function setLevelCh(ch) {
  S.levelCh = ch;
  $$("#level-ch [data-ch]").forEach((b) => b.classList.toggle("active", b.dataset.ch === ch));
  drawLevels();
}
$$("#level-ch [data-ch]").forEach((b) => (b.onclick = () => setLevelCh(b.dataset.ch)));
// eyedroppers: place a black / grey / white sample and solve straight away
$$("[data-dropper]").forEach((b) => (b.onclick = () => { setTool(b.dataset.dropper); S.dropper = true; markDroppers(); }));
function markDroppers() { $$("[data-dropper]").forEach((b) => b.classList.toggle("active", !!S.dropper && b.dataset.dropper === S.tool)); }

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
  S.levelDrag = { which, x0: p.x, start: levelValue(which, curLevel()), fine: ev.altKey };
  if (which === "lo" || which === "hi") S.mask = { kind: "clip" };
  startDrag(); drawLevels(); drawOverlay();
});

window.addEventListener("mousemove", (ev) => {
  if (!S.levelDrag) {
    if (ev.target === levelsCanvas) levelsCanvas.style.cursor = S.levelMagnify ? (ev.altKey ? "zoom-out" : "zoom-in") : levelHandleAt(levelPoint(ev)) ? "ew-resize" : "pointer";
    return;
  }
  const D = S.levelDrag, p = levelPoint(ev), g = levelGeom();
  // ⌥ held: a tenth of the speed. Pressing or releasing it mid-drag re-anchors, so the handle doesn't jump.
  if (ev.altKey !== D.fine) { D.fine = ev.altKey; D.x0 = p.x; D.start = levelValue(D.which, curLevel()); }
  const dx = (p.x - D.x0) / g.span * (D.fine ? 0.1 : 1), scale = D.which.startsWith("out") ? 1 : S.levelView[1] - S.levelView[0];
  setLevelHandle(D.which, D.start + dx * scale);
  if (D.fine) hint("Levels: fine adjustment (⌥)");
  drawLevels(); render();
  if (S.mask) { cancelAnimationFrame(S.clipFrame); S.clipFrame = requestAnimationFrame(drawOverlay); }
});

window.addEventListener("mouseup", () => {
  if (S.levelDrag) { S.levelDrag = null; if ((hint.last || "").startsWith("Levels: fine")) hint(""); if (S.mask && S.mask.kind === "clip") { S.mask = null; drawOverlay(); } commit(); endDrag(); }
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
    if (panel.id === "scope-panel") drawScope();
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
  syncLight();
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
// ---- white balance: what Solve makes the greys look like
let LIGHT_PRESETS = {};
const PRESET_NAMES = { "overcast / shade": "Shade", neutral: "Neutral", daylight: "Daylight", "golden hour": "Golden hour", tungsten: "Tungsten" };

function syncLight() {
  const L = S.params.light;
  $("#light-warmth").value = L.warmth; $("#light-warmth").nextElementSibling.value = (+L.warmth).toFixed(2);
  $("#light-tint").value = L.tint; $("#light-tint").nextElementSibling.value = (+L.tint).toFixed(2);
  $$("#light-ranges input[data-range]").forEach((el) => { el.value = L[el.dataset.range][+el.dataset.i]; el.nextElementSibling.value = (+el.value).toFixed(2); });
  const hit = Object.keys(LIGHT_PRESETS).find((k) => Math.abs(LIGHT_PRESETS[k] - L.warmth) < 0.005);
  $("#light-preset").value = hit || "custom";
  const leaning = ["shadows", "midtones", "highlights"].some((r) => L[r][0] || L[r][1]);
  $("#light-ranges summary").textContent = "By brightness" + (leaning ? " •" : "");
}

// A changed light re-solves at once when there are samples, so you see its effect.
function lightChanged() {
  syncLight(); commit();
  if (solvable()) $("#btn-solve").onclick(); else refreshReport();
}

function lightSlider(el, get, set) {
  const num = el.nextElementSibling && el.nextElementSibling.classList.contains("num") ? el.nextElementSibling : null;
  const setValue = (v) => { set(clamp(Math.round(v * 100) / 100, +el.min, +el.max)); syncLight(); };
  el.addEventListener("input", () => setValue(+el.value));
  el.addEventListener("change", lightChanged);
  el.addEventListener("dblclick", () => { setValue(0); lightChanged(); });
  if (!num) return;
  num.addEventListener("focus", () => num.select());
  num.addEventListener("keydown", (ev) => {
    const step = { ArrowUp: 0.1, ArrowDown: -0.1, ArrowRight: 0.01, ArrowLeft: -0.01 }[ev.key];
    if (step) { ev.preventDefault(); setValue(get() + step); clearTimeout(num.t); num.t = setTimeout(lightChanged, 500); }
    else if (ev.key === "Enter") { const v = parseFloat(num.value.replace(",", ".").replace("−", "-")); if (Number.isFinite(v)) { setValue(v); lightChanged(); } num.blur(); }
  });
  num.addEventListener("blur", () => syncLight());
}
$("#light-preset").onchange = (e) => { if (e.target.value in LIGHT_PRESETS) { S.params.light.warmth = LIGHT_PRESETS[e.target.value]; lightChanged(); } };
lightSlider($("#light-warmth"), () => S.params.light.warmth, (v) => (S.params.light.warmth = v));
lightSlider($("#light-tint"), () => S.params.light.tint, (v) => (S.params.light.tint = v));
$$("#light-ranges input[data-range]").forEach((el) =>
  lightSlider(el, () => S.params.light[el.dataset.range][+el.dataset.i], (v) => (S.params.light[el.dataset.range][+el.dataset.i] = v)));

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
  S.tool = t; S.dropper = false; markDroppers();
  if (["neutral", "white", "black", "skin"].includes(t)) setShown("samples", true);
  $$("[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
  overlay.style.cursor = t === "push" ? "move" : t === "light" ? "ns-resize" : "crosshair";
  if (t === "crop") fitView();
  document.body.classList.toggle("cropping", t === "crop");
  document.body.classList.toggle("dusting", t === "dust");
  if (t !== "dust") { S.clone = null; S.dustTry = null; }
  if (t === "dust") {  // positions follow the current straightening
    renderDust();
    api("dust", { params: S.params }).then((r) => { S.dust = r; renderDust(); drawOverlay(); }).catch(console.error);
  }
  if (t === "crop") { setGeom("angle", S.params.angle || 0); setGeom("distortion", S.params.distortion || 0); setLeveling(false); }
  if (t === "crop" || currentFull) render(); else drawOverlay();
  hint({
    push: "click a spot, then drag towards a colour; further = stronger. [ ] = width",
    light: "click a spot, then drag up to brighten or down to darken that brightness. [ ] = width",
    crop: "drag on the picture for a new crop, outside it to rotate",
    dust: "click a circle to switch its repair, click elsewhere to mark a spot. Hold \\ to compare",
  }[t] || "");
}
// Eye buttons: show or hide samples / measured points on the image.
function setShown(which, on) {
  S.showSamples = on;
  const b = $(`[data-eye="${which}"]`);
  b.classList.toggle("off", !on);
  b.title = (on ? "Hide " : "Show ") + "points on the image";
  drawOverlay();
}
$$("[data-eye]").forEach((b) => b.addEventListener("click", (ev) => {
  ev.stopPropagation();  // the title click would fold the panel
  setShown(b.dataset.eye, b.classList.contains("off"));
}));
$$("[data-tool]").forEach((b) => (b.onclick = () => setTool(S.tool === b.dataset.tool && b.classList.contains("target") ? "probe" : b.dataset.tool)));
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
  if (!["lightness", "r", "g", "b"].includes(c)) c = "lightness";  // e.g. "colour" from an older version
  S.curve = c;
  $$("#curve-tabs [data-curve]").forEach((b) => b.classList.toggle("active", b.dataset.curve === c));
  drawCurve(); renderZones();
}
function setColourCurve(c) {
  S.colourCurve = c;
  $$("#colour-tabs [data-curve]").forEach((b) => b.classList.toggle("active", b.dataset.curve === c));
  drawCurve();
}
$$("#curve-tabs [data-curve]").forEach((b) => (b.onclick = () => setCurve(b.dataset.curve)));
$$("#colour-tabs [data-curve]").forEach((b) => (b.onclick = () => setColourCurve(b.dataset.curve)));
$("#zoom").onchange = (e) => {
  if (e.target.value === "classic") S.curveView = "classic"; else { S.curveView = "zoom"; S.zoom = +e.target.value; }
  try { localStorage.setItem("filmneg.curveView", e.target.value); } catch (err) { /* ignore */ }
  drawCurve();
};
$("#colour-zoom").onchange = (e) => {
  S.colourZoom = +e.target.value;
  try { localStorage.setItem("filmneg.colourZoom", e.target.value); } catch (err) { /* ignore */ }
  drawCurve();
};
try {
  const v = localStorage.getItem("filmneg.curveView"); if (v) { $("#zoom").value = v; $("#zoom").onchange({ target: $("#zoom") }); }
  const z = localStorage.getItem("filmneg.colourZoom"); if (z) { $("#colour-zoom").value = z; S.colourZoom = +z; }
} catch (err) { /* ignore */ }

$("#btn-auto").onclick = () => guard("Auto", async () => { S.params = (await api("levels", { params: S.params })).params; syncControls(); render(); commit(); });
$("#btn-solve").onclick = () => guard("Solve", async () => {
  if (!solvable()) throw new Error("give a point a role first: Grey, White, Black or Skin");
  const r = await api("solve", { params: S.params, samples: S.samples });
  S.params = r.params; S.report = r.report; S.casts = r.casts;
  // Solve bends the Colour by tone curves: widen that view if they no longer fit
  const most = Math.max(...["warmth", "tint"].flatMap((n) => S.params.curves[n].map(Math.abs)));
  if (most > S.colourZoom * 0.9) {
    const opt = [...$("#colour-zoom").options].find((o) => +o.value * 0.9 >= most) || [...$("#colour-zoom").options].pop();
    $("#colour-zoom").value = opt.value; S.colourZoom = +opt.value;
  }
  syncControls(); render(); drawCurve(); drawLevels(); renderPoints(); commit();
});
$("#points-clear").onclick = () => { S.samples = []; S.sel = null; S.readings = []; S.report = []; commit(); renderPoints(); drawOverlay(); drawCurve(); };
$("#btn-undo").onclick = undo;
$("#btn-redo").onclick = redo;
$("#btn-fit").onclick = fitView;
$("#btn-reset").onclick = () => guard("Reset", async () => {
  const keep = { crop: S.params.crop, mode: S.params.mode, light: S.params.light };
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
  if (k === "escape") {
    closeMenu();
    if (S.tool === "dust" && S.clone) { S.clone = null; hint(""); drawOverlay(); return; }        // drop the clone source
    if (S.tool === "dust" && S.dustSel) { S.dustSel = null; S.dustTry = null; renderDust(); render(); return; }  // back to the overview
    setTool("probe"); return;
  }
  if (S.tool === "dust" && dustKey(ev)) return;
  if (k === "\\") { compare(true); return; }
  if (k === "[") { setWidth(S.width * 0.85); return; }
  if (k === "]") { setWidth(S.width / 0.85); return; }
  if (k === "0") { fitView(); return; }
  const tools = { p: "probe", c: "push", l: "light", n: "neutral", w: "white", k: "black", s: "skin", r: "crop", d: "dust" };
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
  S.doc = d; S.params = d.params; S.samples = d.samples || []; S.dust = d.dust; S.dustSel = null; S.dustVer = (S.dustVer || 0) + 1; S.versions = d.versions || []; S.undo = []; S.redo = []; S.sel = null; S.readings = [];
  S.lastCommitted = snapshot();
  $("#file").innerHTML = d.files.map((f) => `<option${f === d.name ? " selected" : ""}>${f}</option>`).join("");
  LIGHT_PRESETS = d.light_presets; ZONES = d.zones || [];
  $("#light-preset").innerHTML = Object.keys(LIGHT_PRESETS).sort((a, b) => LIGHT_PRESETS[a] - LIGHT_PRESETS[b])
    .map((k) => `<option value="${k}">${PRESET_NAMES[k] || k}</option>`).join("") + `<option value="custom" disabled>Custom</option>`;
  location.hash = encodeURIComponent(d.name);
  document.title = d.name + " · filmneg";
  S.view = { scale: 1, cx: 0.5, cy: 0.5 }; detail = null; S.levelHist = null; S.levelHistKey = null;
  syncControls(); setCurve(S.curve); setColourCurve(S.colourCurve); setLevelCh(S.levelCh); renderVersions(); setTool("probe"); renderPoints(); refreshReport();
  status(`${d.name} · ${d.width}×${d.height} · ${d.profile || "no profile, assuming sRGB"}`, 6000);
  render();
}

sizeCanvases();
load(decodeURIComponent(location.hash.slice(1)) || null);
