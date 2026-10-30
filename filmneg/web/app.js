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
  zoom: 0.04,         // curve panel shows ±zoom (encoded units)
  width: 0.12,        // soft-edit width on the tone axis (push tools and curves)
  soft: 0.5,          // softness of sample areas: how far in from the edge their weight starts fading
  probes: [],         // pinned probes: {at, res}
  probeSel: null,     // which probe the detail table shows
  push: null,         // active push gesture (colour or light)
  undo: [], redo: [],
  variants: null,     // {state, cells}
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
  $("#width").value = S.width;
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
}

function restore(snap) {
  S.params = clone(snap.params);
  S.samples = clone(snap.samples);
  S.lastCommitted = snapshot();
  syncControls(); render(); drawCurve(); drawOverlay(); refreshReport(); scheduleSave();
}

function undo() { if (S.undo.length) { S.redo.push(snapshot()); restore(S.undo.pop()); } }
function redo() { if (S.redo.length) { S.undo.push(snapshot()); restore(S.redo.pop()); } }

function scheduleSave() {
  clearTimeout(scheduleSave.t);
  scheduleSave.t = setTimeout(() => {
    api("save", { params: S.params, samples: S.samples, history: [] }).catch((e) => status("save failed: " + e.message));
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
  if (inflight) { dirty = true; return; }
  inflight = true; dirty = false;
  const gen = renderGen;
  try {
    const full = S.tool === "crop";
    current = await fetchImage({ params: viewParams(), original: S.comparing, size: S.dragging ? "drag" : "preview" });
    currentFull = full;
    readPreview();
    drawImage();
    drawScopes();
    drawCurve();
    if (!S.dragging && !dirty && gen === renderGen) { scheduleDetail(); refreshProbes(); }
  } catch (e) { status("render failed: " + e.message, 8000); }
  inflight = false;
  if (dirty) render();
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

// A canvas the size of previewPx: dims what a push leaves alone, or marks clipped pixels.
function maskCanvas() {
  if (!S.mask || !previewPx) return null;
  const key = JSON.stringify(S.mask) + previewPx.w;
  if (S.maskCache && S.maskCache.key === key) return S.maskCache.canvas;
  const { w, h, data } = previewPx;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d"), im = ctx.createImageData(w, h), o = im.data;
  for (let i = 0; i < data.length; i += 4) {
    if (S.mask.kind === "push") {
      const t = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      const wgt = Math.exp(-0.5 * ((t - S.mask.tone) / S.mask.width) ** 2);
      o[i] = o[i + 1] = o[i + 2] = 110; o[i + 3] = (1 - wgt) * 190;  // grey veil over what stays untouched
    } else {
      const hi = data[i] >= 254 || data[i + 1] >= 254 || data[i + 2] >= 254;
      const lo = data[i] <= 1 || data[i + 1] <= 1 || data[i + 2] <= 1;
      if (hi) { o[i] = 255; o[i + 1] = 40; o[i + 2] = 40; o[i + 3] = 220; }
      else if (lo) { o[i] = 40; o[i + 1] = 110; o[i + 2] = 255; o[i + 3] = 220; }
    }
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
    ctx.fillStyle = "rgba(0,0,0,.5)";
    ctx.fillRect(r.x, r.y, r.w, a.y - r.y);
    ctx.fillRect(r.x, b.y, r.w, r.y + r.h - b.y);
    ctx.fillRect(r.x, a.y, a.x - r.x, b.y - a.y);
    ctx.fillRect(b.x, a.y, r.x + r.w - b.x, b.y - a.y);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    return;
  }

  const m = maskCanvas();
  if (m) { const r = fitRect(); ctx.imageSmoothingEnabled = false; ctx.drawImage(m, r.x, r.y, r.w, r.h); ctx.imageSmoothingEnabled = true; }

  S.samples.forEach((s, i) => drawBrush(ctx, s, KIND_COLOR[s.kind], String(i + 1)));
  if (S.brush) drawBrush(ctx, S.brush, S.brush.kind ? KIND_COLOR[S.brush.kind] : "#fff", S.brush.label);
  if (S.tool === "probe" || S.tool === "push" || S.tool === "light") S.probes.forEach((p, i) => drawBrush(ctx, p.at, PROBE_COLORS[i % PROBE_COLORS.length], "P" + (i + 1), true));

  if (S.push) S.push.kind === "light" ? drawLightBar(ctx) : drawWheel(ctx);
}

// A sample area drawn like a soft brush: solid ring where it counts fully,
// dashed ring where its weight fades out. A point sample is a small cross.
function drawBrush(ctx, s, color, label, dashed = false) {
  const p = toScreen(s.x, s.y), rad = radiusPx(s.r || 0), inner = rad * (1 - (s.soft ?? 0.5));
  const outline = color === "#000" ? "#fff" : "#000";
  ctx.save();
  if (rad < 3) {
    for (const [c, w] of [[outline, 4], [color, 2]]) {
      ctx.strokeStyle = c; ctx.lineWidth = w; ctx.beginPath();
      ctx.moveTo(p.x - 6, p.y); ctx.lineTo(p.x + 6, p.y); ctx.moveTo(p.x, p.y - 6); ctx.lineTo(p.x, p.y + 6); ctx.stroke();
    }
  } else {
    if (dashed) ctx.setLineDash([3, 3]);
    for (const [c, w] of [[outline, 3.5], [color, 1.5]]) {
      ctx.strokeStyle = c; ctx.lineWidth = w;
      if (inner > 1.5) { ctx.beginPath(); ctx.arc(p.x, p.y, inner, 0, 7); ctx.stroke(); }
    }
    ctx.setLineDash([4, 4]);
    for (const [c, w] of [[outline, 3], [color, 1.2]]) {
      ctx.strokeStyle = c; ctx.lineWidth = w; ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 7); ctx.stroke();
    }
  }
  if (label) { ctx.fillStyle = "#fff"; ctx.font = "11px sans-serif"; ctx.fillText(label, p.x + Math.max(rad, 6) + 4, p.y - Math.max(rad, 6)); }
  ctx.restore();
}

// Colour wheel for the push tool. Right = magenta, up = yellow, left = green, down = blue,
// the same directions as the vectorscope.
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
  if (!S.doc) return;
  const p = toScan(ev);
  const tool = S.tool;

  if (tool === "crop") {
    S.cropStart = p; S.cropDrag = [p.x, p.y, p.x, p.y]; return;
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
    // a click takes one point; dragging grows a soft brush-like area from the click
    S.brush = { kind: tool === "probe" ? null : tool, x: p.x, y: p.y, r: 0, soft: S.soft, sx: ev.clientX, sy: ev.clientY,
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

window.addEventListener("mousemove", (ev) => {
  if (S.cropStart) {
    const p = toScan(ev), a = S.cropStart;
    S.cropDrag = [clamp(Math.min(a.x, p.x), 0, 1), clamp(Math.min(a.y, p.y), 0, 1), clamp(Math.max(a.x, p.x), 0, 1), clamp(Math.max(a.y, p.y), 0, 1)];
    drawOverlay(); return;
  }
  if (S.brush) {
    const d = Math.hypot(ev.clientX - S.brush.sx, ev.clientY - S.brush.sy);
    S.brush.r = d < 4 ? 0 : d / radiusPx(1);
    hint(S.brush.r ? `area ${Math.round(d)} px · softness ${Math.round(S.brush.soft * 100)}% (scroll to change)` : "");
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
    hint(`light at tone ${(P.tone * 100).toFixed(0)}%: ${fmt(a * 255)} · width ${S.width.toFixed(2)} ([ ] or scroll) · ⌥ finer · dimmed = not affected`);
  } else {
    const d = Math.hypot(dx, dy), a = pushStrength(d, fine);
    const tint = d ? a * dx / d : 0, warm = d ? a * -dy / d : 0;
    S.params.curves.warmth = addTo(P.base.warmth, bump(P.tone, warm, S.width));
    S.params.curves.tint = addTo(P.base.tint, bump(P.tone, tint, S.width));
    hint(`colour at tone ${(P.tone * 100).toFixed(0)}%: warmth ${fmt(warm * 255)}, tint ${fmt(tint * 255)} · width ${S.width.toFixed(2)} ([ ] or scroll) · ⌥ finer · dimmed = not affected`);
  }
  render(); drawCurve();
}

window.addEventListener("mouseup", () => {
  S.pan = null;
  if (S.brush) {
    const { kind, x, y, r, soft } = S.brush;
    S.brush = null; hint("");
    if (kind) { S.samples.push({ kind, x, y, r, soft }); renderSamples(); commit(); drawOverlay(); }
    else doProbe({ x, y, r, soft });
  }
  if (S.sampleMove) {
    if (S.sampleMove.moved) S.sampleMove.probe ? refreshProbes() : commit();
    S.sampleMove = null;
  }
  if (S.cropStart) {
    const c = S.cropDrag;
    S.cropStart = null; S.cropDrag = null;
    if (c[2] - c[0] > 0.05 && c[3] - c[1] > 0.05) {
      S.params.crop = c;
      guard("Levels", async () => { S.params = (await api("levels", { params: S.params })).params; commit(); setTool("probe"); });
    } else drawOverlay();
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
  if (S.push) { setWidth(S.width * (ev.deltaY > 0 ? 1.06 : 0.94)); return; }
  if (S.brush) {
    S.brush.soft = S.soft = clamp(S.brush.soft + (ev.deltaY > 0 ? -0.04 : 0.04), 0, 1);
    $("#soft").value = S.soft; drawOverlay();
    hint(`softness ${Math.round(S.soft * 100)}%`); return;
  }
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
  if (!S.probes.length) { box.innerHTML = "Probe tool: click a spot or drag an area. Each click adds a probe (P1, P2, …); ⇧-click one to remove it, drag it to move it."; return; }
  const sel = clamp(S.probeSel ?? S.probes.length - 1, 0, S.probes.length - 1);
  const rows = S.probes.map((q, i) => `<li data-i="${i}" class="${i === sel ? "sel" : ""}"><span class="dot" style="background:${PROBE_COLORS[i % PROBE_COLORS.length]}"></span>
    <span>P${i + 1}</span><span class="res">${(q.res.tone * 100).toFixed(0)}% · ${castWords(q.res.a, q.res.b).replace(/ \(.*\)/, "")}</span><button title="Remove">×</button></li>`).join("");
  box.innerHTML = `<ul id="probe-list">${rows}</ul><div id="probe-detail"></div><button id="probe-clear">Clear probes</button>`;
  box.querySelectorAll("li").forEach((li) => {
    const i = +li.dataset.i;
    li.onclick = () => { S.probeSel = i; showProbe(); };
    li.querySelector("button").onclick = (e) => { e.stopPropagation(); S.probes.splice(i, 1); S.probeSel = null; showProbe(); drawOverlay(); drawCurve(); };
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
function renderSamples() {
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
    li.innerHTML = `<span class="dot" style="background:${KIND_COLOR[s.kind]}"></span><span>${i + 1} ${s.kind}</span><span class="res ${bad ? "bad" : ""}">${txt}</span><button title="Remove">×</button>`;
    li.querySelector("button").onclick = () => { S.samples.splice(i, 1); renderSamples(); drawOverlay(); commit(); };
    ul.appendChild(li);
  });
}

async function refreshReport() {
  clearTimeout(refreshReport.t);
  refreshReport.t = setTimeout(async () => {
    try { S.report = (await api("report", { params: S.params, samples: S.samples })).report; renderSamples(); }
    catch (e) { console.error(e); }
  }, 300);
}

// ---------------------------------------------------------------- curves panel
const curveCanvas = $("#curve");
const CURVE_COLORS = { lightness: "#ddd", r: "#f66", g: "#6d6", b: "#69f", warmth: "#e8c040", tint: "#d070d0" };
const LEVELS_H = 22;  // strip at the bottom of the curve panel holding the black/white point handles

function curveGeom() {
  const W = curveCanvas.width, H = curveCanvas.height - LEVELS_H, pad = 14;
  return { W, H, pad, x: (t) => pad + t * (W - 2 * pad), y: (v) => H / 2 - (v / S.zoom) * (H / 2 - pad),
           t: (px) => (px - pad) / (W - 2 * pad), v: (py) => -(py - H / 2) / (H / 2 - pad) * S.zoom };
}

const curveNames = () => (S.curve === "colour" ? ["warmth", "tint"] : [S.curve]);

// What colour the image moves towards when each curve goes up (first) or down.
const CURVE_DIRECTIONS = {
  warmth: ["#ffd23c", "#3c78ff"], tint: ["#e040e0", "#40e040"], lightness: ["#ffffff", "#000000"],
  r: ["#ff4040", "#30e0e0"], g: ["#40e040", "#e040e0"], b: ["#4070ff", "#ffe040"],
};

// Which channels the black/white handles move in the current tab.
const levelChannels = () => (["r", "g", "b"].includes(S.curve) ? ["rgb".indexOf(S.curve)] : [0, 1, 2]);
function levelPos(which) {
  const ch = levelChannels(), L = S.params.levels[which];
  return ch.reduce((s, c) => s + L[c], 0) / ch.length;
}

function drawCurve() {
  if (!S.params) return;
  const ctx = curveCanvas.getContext("2d"), g = curveGeom();
  ctx.clearRect(0, 0, curveCanvas.width, curveCanvas.height);

  // background: the colour the image moves towards above and below the line
  const dirName = S.curveDrag ? S.curveDrag.name : (S.curve === "colour" ? (S.hoverName || "warmth") : S.curve);
  const [up, down] = CURVE_DIRECTIONS[dirName];
  const bg = ctx.createLinearGradient(0, 0, 0, g.H);
  bg.addColorStop(0, up); bg.addColorStop(0.5, "rgba(0,0,0,0)"); bg.addColorStop(1, down);
  ctx.globalAlpha = 0.16; ctx.fillStyle = bg; ctx.fillRect(0, 0, g.W, g.H); ctx.globalAlpha = 1;

  // histogram of the current preview behind everything
  if (S.hist) {
    const h = S.hist[S.curve === "colour" ? "lightness" : S.curve], B = h.length;
    let max = 0; for (let i = 2; i < B - 2; i++) max = Math.max(max, h[i]);
    ctx.fillStyle = S.curve === "colour" || S.curve === "lightness" ? "rgba(255,255,255,.10)" : CURVE_COLORS[S.curve] + "2a";
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
  for (const v of [-0.75, -0.5, -0.25, 0.25, 0.5, 0.75]) {
    ctx.strokeStyle = "#2f2f2f"; ctx.beginPath(); ctx.moveTo(0, g.y(v * S.zoom)); ctx.lineTo(g.W, g.y(v * S.zoom)); ctx.stroke();
  }
  ctx.strokeStyle = "#666"; ctx.beginPath(); ctx.moveTo(0, g.y(0)); ctx.lineTo(g.W, g.y(0)); ctx.stroke();
  ctx.fillStyle = "#666"; ctx.textAlign = "left";
  ctx.fillText(`+${Math.round(S.zoom * 255)}`, 2, 12); ctx.fillText(`−${Math.round(S.zoom * 255)}`, 2, g.H - 16);

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
    const active = !shown || shown.name === name;
    const pts = [];
    for (let i = 0; i <= 200; i++) pts.push([i / 200, splineAt(ctrl, i / 200)]);
    // curvature comb: second difference drawn as hairlines from the curve
    ctx.strokeStyle = CURVE_COLORS[name] + "55"; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 1; i < pts.length - 1; i += 2) {
      const k = (pts[i - 1][1] - 2 * pts[i][1] + pts[i + 1][1]) * 200 * 200;
      const x = g.x(pts[i][0]), y = g.y(pts[i][1]);
      ctx.moveTo(x, y); ctx.lineTo(x, y + k * 0.01 / S.zoom * 4);
    }
    ctx.stroke();
    ctx.strokeStyle = CURVE_COLORS[name]; ctx.lineWidth = active ? 2.5 : 1.2; ctx.globalAlpha = active ? 1 : 0.55;
    ctx.beginPath();
    pts.forEach(([t, v], i) => (i ? ctx.lineTo(g.x(t), g.y(v)) : ctx.moveTo(g.x(t), g.y(v))));
    ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = CURVE_COLORS[name] + "99";
    ctrl.forEach((v, i) => { ctx.beginPath(); ctx.arc(g.x(CTRL_POS[i]), g.y(v), 2, 0, 7); ctx.fill(); });
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

  // levels strip: tone ramp plus black and white point handles
  const y0 = g.H + 4;
  const ramp = ctx.createLinearGradient(g.x(0), 0, g.x(1), 0);
  ramp.addColorStop(0, "#000"); ramp.addColorStop(1, "#fff");
  ctx.fillStyle = ramp; ctx.fillRect(g.x(0), y0, g.x(1) - g.x(0), 5);
  for (const [which, fill] of [["lo", "#000"], ["hi", "#fff"]]) {
    const x = g.x(levelPos(which));
    ctx.fillStyle = fill; ctx.strokeStyle = "#aaa"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, y0 + 6); ctx.lineTo(x - 8, y0 + 18); ctx.lineTo(x + 8, y0 + 18); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
}

// Which curve and how wide an edit starting at canvas point (px, py) would be.
// On a curve: the width setting. Further from it: broader, so a far grab moves a wide range of tones.
function editAt(px, py) {
  const g = curveGeom(), t = clamp(g.t(px), 0, 1);
  let best = null;
  for (const name of curveNames()) {
    const d = Math.abs(py - g.y(splineAt(S.params.curves[name], t)));
    if (!best || d < best.d) best = { name, d };
  }
  const near = 12 * curveCanvas.width / curveCanvas.clientWidth;
  const far = Math.max(0, best.d - near) / (g.H / 2 - g.pad);
  return { name: best.name, t, width: clamp(S.width * (1 + 3 * far), 0.03, 1.5) };
}

const canvasPoint = (ev) => {
  const b = curveCanvas.getBoundingClientRect(), sc = curveCanvas.width / b.width;
  return { x: (ev.clientX - b.left) * sc, y: (ev.clientY - b.top) * sc, sc };
};

curveCanvas.addEventListener("mousedown", (ev) => {
  const p = canvasPoint(ev), g = curveGeom();
  if (p.y > g.H) {  // levels strip
    const which = Math.abs(p.x - g.x(levelPos("lo"))) < Math.abs(p.x - g.x(levelPos("hi"))) ? "lo" : "hi";
    S.levelDrag = { which, x0: p.x, base: clone(S.params.levels) };
    S.mask = { kind: "clip" }; startDrag(); drawOverlay();
    return;
  }
  const e = editAt(p.x, p.y);
  S.curveDrag = { ...e, y0: p.y, amount: 0, base: clone(S.params.curves) };
  startDrag(); drawCurve();
});

window.addEventListener("mousemove", (ev) => {
  const p = canvasPoint(ev), g = curveGeom();
  if (S.levelDrag) {
    const L = S.levelDrag, dt = (p.x - L.x0) / (g.W - 2 * g.pad) * (ev.altKey ? 0.2 : 1);
    for (const c of levelChannels()) {
      const v = L.base[L.which][c] + dt;
      S.params.levels[L.which][c] = L.which === "lo" ? clamp(v, -0.2, S.params.levels.hi[c] - 0.05) : clamp(v, S.params.levels.lo[c] + 0.05, 1.2);
    }
    hint(`black point ${Math.round(levelPos("lo") * 255)} · white point ${Math.round(levelPos("hi") * 255)} · red/blue on the image = clipped · ⌥ finer`);
    drawCurve(); render(); return;
  }
  if (!S.curveDrag) {
    if (ev.target === curveCanvas && p.y <= g.H) {
      S.hoverEdit = editAt(p.x, p.y); S.hoverName = S.hoverEdit.name; drawCurve();
    }
    return;
  }
  const D = S.curveDrag;
  const gain = ev.altKey ? 0.2 : ev.shiftKey ? 3 : 1;
  D.amount = -(p.y - D.y0) * (S.zoom * 2) / (g.H - 2 * g.pad) * 0.5 * gain;
  S.params.curves[D.name] = addTo(D.base[D.name], bump(D.t, D.amount, D.width));
  drawCurve(); render();
});

window.addEventListener("mouseup", () => {
  if (S.levelDrag) { S.levelDrag = null; S.mask = null; hint(""); drawOverlay(); commit(); endDrag(); }
  if (S.curveDrag) { S.curveDrag = null; commit(); endDrag(); drawCurve(); }
});
curveCanvas.addEventListener("mouseleave", () => { S.hoverEdit = null; drawCurve(); });
curveCanvas.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  setWidth(S.width * (ev.deltaY > 0 ? 1.06 : 0.94));
  if (S.hoverEdit) { const p = canvasPoint(ev); S.hoverEdit = editAt(p.x, p.y); drawCurve(); }
}, { passive: false });
// Smooth the shown curve(s), like Rhino's Smooth: each control value moves part of
// the way towards the average of its neighbours. Repeat for more.
function smoothCurves() {
  for (const n of curveNames()) {
    const c = S.params.curves[n];
    S.params.curves[n] = c.map((v, i) => {
      const l = c[Math.max(0, i - 1)], r = c[Math.min(c.length - 1, i + 1)];
      return v + 0.5 * ((l + r) / 2 - v);
    });
  }
  drawCurve(); render(); commit();
}
$("#btn-smooth").onclick = smoothCurves;

curveCanvas.addEventListener("dblclick", (ev) => {
  const p = canvasPoint(ev), g = curveGeom();
  if (p.y > g.H) {
    for (const c of levelChannels()) { S.params.levels.lo[c] = 0; S.params.levels.hi[c] = 1; }
  } else {
    for (const n of curveNames()) S.params.curves[n] = Array(N_CTRL).fill(0);
  }
  drawCurve(); render(); commit();
});

// ---------------------------------------------------------------- scopes (from the preview pixels)
function srgbToOklab(r, g, b) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  r = lin(r); g = lin(g); b = lin(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
          1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
          0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function drawScopes() {
  if (!previewPx) return;
  // scopes use a 300 px wide copy for speed
  const step = Math.max(1, Math.round(previewPx.w / 300));
  const w = Math.floor(previewPx.w / step), h = Math.floor(previewPx.h / step), src = previewPx.data;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((y * step) * previewPx.w + x * step) * 4, o = (y * w + x) * 4;
    px[o] = src[i]; px[o + 1] = src[i + 1]; px[o + 2] = src[i + 2];
  }

  // RGB parade: each channel gets a third of the width; x = image column, y = value
  const pc = $("#parade"), pctx = pc.getContext("2d"), PW = pc.width, PH = pc.height;
  const acc = new Float32Array(PW * PH * 3);
  const third = Math.floor(PW / 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, col = Math.floor(x * third / w);
    for (let c = 0; c < 3; c++) {
      const row = PH - 1 - Math.round(px[i + c] / 255 * (PH - 1));
      acc[(row * PW + c * third + col) * 3 + c] += 1;
    }
  }
  const pim = pctx.createImageData(PW, PH), gain = 255 * 1.5 * third / (w * h) * PH;
  for (let i = 0; i < PW * PH; i++) {
    pim.data[i * 4] = Math.min(255, acc[i * 3] * gain);
    pim.data[i * 4 + 1] = Math.min(255, acc[i * 3 + 1] * gain);
    pim.data[i * 4 + 2] = Math.min(255, acc[i * 3 + 2] * gain);
    pim.data[i * 4 + 3] = 255;
  }
  pctx.putImageData(pim, 0, 0);
  pctx.strokeStyle = "#333";
  for (const v of [0.25, 0.5, 0.75]) { pctx.beginPath(); pctx.moveTo(0, PH * v); pctx.lineTo(PW, PH * v); pctx.stroke(); }

  // Cast vs tone (near-neutral pixels) and vectorscope
  const BINS = 32, sa = new Float32Array(BINS), sb = new Float32Array(BINS), n = new Float32Array(BINS);
  const vc = $("#vector"), vctx = vc.getContext("2d"), VW = vc.width;
  const vim = vctx.createImageData(VW, VW), vacc = new Float32Array(VW * VW), VS = VW / 2 / 0.16;
  for (let i = 0; i < px.length; i += 4) {
    const [, a, b] = srgbToOklab(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
    const vx = Math.round(VW / 2 + a * VS), vy = Math.round(VW / 2 - b * VS);
    if (vx >= 0 && vx < VW && vy >= 0 && vy < VW) vacc[vy * VW + vx]++;
    if (Math.hypot(a, b) < 0.04) {
      const t = 0.2126 * px[i] / 255 + 0.7152 * px[i + 1] / 255 + 0.0722 * px[i + 2] / 255;
      const k = Math.min(BINS - 1, Math.floor(t * BINS));
      sa[k] += a; sb[k] += b; n[k]++;
    }
  }
  const vg = 255 * 40 / (w * h) * VW;
  for (let i = 0; i < VW * VW; i++) {
    const v = Math.min(255, Math.sqrt(vacc[i] * vg) * 16);
    vim.data[i * 4] = vim.data[i * 4 + 1] = vim.data[i * 4 + 2] = v; vim.data[i * 4 + 3] = 255;
  }
  vctx.putImageData(vim, 0, 0);
  vctx.strokeStyle = "#444"; vctx.beginPath(); vctx.arc(VW / 2, VW / 2, VW / 2 - 1, 0, 7);
  vctx.moveTo(0, VW / 2); vctx.lineTo(VW, VW / 2); vctx.moveTo(VW / 2, 0); vctx.lineTo(VW / 2, VW); vctx.stroke();
  // skin tone line (hue from typical skin, same as the server)
  vctx.strokeStyle = "#e9a37a"; vctx.setLineDash([3, 3]); vctx.beginPath(); vctx.moveTo(VW / 2, VW / 2);
  vctx.lineTo(VW / 2 + Math.cos(SKIN_HUE) * VW / 2, VW / 2 - Math.sin(SKIN_HUE) * VW / 2); vctx.stroke(); vctx.setLineDash([]);
  vctx.fillStyle = "#777"; vctx.font = "9px sans-serif";
  vctx.fillText("Y", VW / 2 + 3, 10); vctx.fillText("M", VW - 10, VW / 2 - 3); vctx.fillText("G", 3, VW / 2 - 3); vctx.fillText("B", VW / 2 + 3, VW - 3);

  const cc = $("#casttone"), cctx = cc.getContext("2d"), CW = cc.width, CH = cc.height, CS = CH / 2 / 0.03;
  cctx.fillStyle = "#111"; cctx.fillRect(0, 0, CW, CH);
  cctx.strokeStyle = "#444"; cctx.beginPath(); cctx.moveTo(0, CH / 2); cctx.lineTo(CW, CH / 2); cctx.stroke();
  for (const [arr, color] of [[sb, CURVE_COLORS.warmth], [sa, CURVE_COLORS.tint]]) {
    cctx.strokeStyle = color; cctx.lineWidth = 2; cctx.beginPath();
    let started = false;
    for (let k = 0; k < BINS; k++) {
      if (n[k] < 15) { started = false; continue; }
      const x = (k + 0.5) / BINS * CW, y = CH / 2 - (arr[k] / n[k]) * CS;
      started ? cctx.lineTo(x, y) : cctx.moveTo(x, y); started = true;
    }
    cctx.stroke();
  }
  cctx.fillStyle = "#777"; cctx.font = "9px sans-serif";
  cctx.fillText("shadows", 3, CH - 3); cctx.fillText("highlights", CW - 48, CH - 3);
  cctx.fillStyle = CURVE_COLORS.warmth; cctx.fillText("yellow ↑ blue ↓", 3, 10);
  cctx.fillStyle = CURVE_COLORS.tint; cctx.fillText("magenta ↑ green ↓", 3, 21);
}

const SKIN_HUE = (() => {
  const skins = [[255, 219, 172], [224, 172, 140], [198, 134, 103], [160, 110, 80], [141, 85, 36], [105, 60, 40]];
  let sx = 0, sy = 0;
  for (const [r, g, b] of skins) { const [, a, bb] = srgbToOklab(r / 255, g / 255, b / 255); const h = Math.atan2(bb, a); sx += Math.cos(h); sy += Math.sin(h); }
  return Math.atan2(sy, sx);
})();

// ---------------------------------------------------------------- variants (ring-around)
let hoverCell = -1;

async function openVariants(pick = null) {
  $("#variants").hidden = false;
  $("#vinfo").textContent = "rendering…";
  const body = { params: S.params, state: S.variants?.state || null };
  if (pick !== null) { body.pick = pick; body.cells = S.variants.cells.map(({ image, ...c }) => c); }
  try {
    const res = await api("variants", body);
    S.variants = { state: res.state, cells: res.cells };
    if (pick !== null) { S.params = res.params; commit(); syncControls(); render(); drawCurve(); }
    const g = $("#vgrid"); g.innerHTML = ""; g.classList.remove("zoom");
    res.cells.forEach((c, i) => {
      const d = document.createElement("div");
      d.className = "cell" + (i === 4 ? " center" : "");
      d.innerHTML = `<img src="${c.image}"><span class="label">${c.label}</span><span class="num">${i + 1}</span>`;
      d.onclick = () => openVariants(i);
      d.onmouseenter = () => (hoverCell = i);
      g.appendChild(d);
    });
    $("#vinfo").textContent = `generation ${res.state.generation} · step ${res.state.step.toFixed(2)} · click the best one, or press 1–9 · hold Space over a cell to see it large · centre = keep and look closer`;
  } catch (e) { status("variants failed: " + e.message, 8000); }
}

function closeVariants() { $("#variants").hidden = true; S.variants = null; }

function enlargeCell(on) {
  const g = $("#vgrid"), cells = [...g.children];
  cells.forEach((c, i) => c.classList.toggle("big", on && i === hoverCell));
  g.classList.toggle("zoom", on && hoverCell >= 0);
}

// ---------------------------------------------------------------- straighten panel
const ST = { base: null, inflight: false, again: false };

function openStraighten() {
  ST.base = clone(S.params);
  $("#straighten").hidden = false;
  for (const id of ["st-strength", "st-smooth"]) $("#" + id).nextElementSibling.textContent = (+$("#" + id).value).toFixed(2);
  setCurve("colour");
  previewStraighten();
}

async function previewStraighten() {
  if (ST.inflight) { ST.again = true; return; }
  ST.inflight = true; ST.again = false;
  try {
    const r = await api("straighten", {
      params: ST.base, strength: +$("#st-strength").value, smoothness: +$("#st-smooth").value, keep_overall: $("#st-keep").checked,
    });
    if (ST.base) { S.params = r.params; render(); drawCurve(); }
  } catch (e) { status("straighten failed: " + e.message, 8000); }
  ST.inflight = false;
  if (ST.again) previewStraighten();
}

function closeStraighten(apply) {
  if (!ST.base) return;
  if (!apply) { S.params = ST.base; render(); drawCurve(); } else commit();
  ST.base = null;
  $("#straighten").hidden = true;
}

for (const id of ["st-strength", "st-smooth"]) {
  $("#" + id).addEventListener("input", (e) => { e.target.nextElementSibling.textContent = (+e.target.value).toFixed(2); previewStraighten(); });
}
$("#st-keep").addEventListener("change", previewStraighten);
$("#st-apply").onclick = () => closeStraighten(true);
$("#st-cancel").onclick = () => closeStraighten(false);

// ---------------------------------------------------------------- controls
const SLIDERS = ["exposure", "contrast", "saturation", "nr"];

function syncControls() {
  for (const k of SLIDERS) {
    const el = $("#" + k); el.value = S.params[k];
    el.nextElementSibling.textContent = (+S.params[k]).toFixed(2);
  }
  $("#lighting").value = S.params.lighting;
}

for (const k of SLIDERS) {
  const el = $("#" + k);
  el.addEventListener("input", () => {
    if (!S.dragging && k !== "nr") startDrag();
    S.params[k] = +el.value; el.nextElementSibling.textContent = (+el.value).toFixed(2); render();
  });
  el.addEventListener("change", () => { commit(); endDrag(); });
  el.addEventListener("dblclick", () => { S.params[k] = k === "exposure" || k === "nr" ? 0 : 1; syncControls(); render(); commit(); });
}
$("#lighting").addEventListener("change", (e) => { S.params.lighting = e.target.value; commit(); });
$("#width").addEventListener("input", (e) => setWidth(+e.target.value));
$("#soft").addEventListener("input", (e) => { S.soft = +e.target.value; });

function setTool(t) {
  S.tool = t;
  $$("#tools [data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
  overlay.style.cursor = t === "push" ? "move" : t === "light" ? "ns-resize" : "crosshair";
  if (t === "crop") fitView();
  if (t === "crop" || currentFull) render(); else drawOverlay();
  hint({
    push: "click a spot, then drag towards a colour; further = stronger. [ ] or scroll while dragging = width",
    light: "click a spot, then drag up to brighten or down to darken that brightness. [ ] or scroll while dragging = width",
    crop: "drag the new crop",
  }[t] || "");
}
$$("#tools [data-tool]").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
$$("[data-surround]").forEach((b) => (b.onclick = () => {
  document.documentElement.style.setProperty("--surround", b.dataset.surround);
  try { localStorage.setItem("filmneg.surround", b.dataset.surround); } catch (e) { /* private mode */ }
}));
try { const s = localStorage.getItem("filmneg.surround"); if (s) document.documentElement.style.setProperty("--surround", s); } catch (e) { /* ignore */ }

function setCurve(c) {
  S.curve = c;
  $$("#curve-tabs [data-curve]").forEach((b) => b.classList.toggle("active", b.dataset.curve === c));
  $("#curve-help").textContent = c === "colour" ? "grab either curve" : "";
  drawCurve();
}
$$("#curve-tabs [data-curve]").forEach((b) => (b.onclick = () => setCurve(b.dataset.curve)));
$("#zoom").onchange = (e) => { S.zoom = +e.target.value; drawCurve(); };

$("#btn-auto").onclick = () => guard("Auto", async () => { S.params = (await api("auto", { params: S.params })).params; syncControls(); render(); commit(); });
$("#btn-solve").onclick = () => guard("Solve", async () => {
  if (!S.samples.length) throw new Error("add some grey, white, black or skin samples first");
  const r = await api("solve", { params: S.params, samples: S.samples });
  S.params = r.params; S.report = r.report; syncControls(); render(); renderSamples(); commit();
});
$("#btn-straighten").onclick = () => ($("#straighten").hidden ? openStraighten() : closeStraighten(false));
$("#btn-variants").onclick = () => openVariants();
$("#v-keep").onclick = closeVariants;
$("#btn-undo").onclick = undo;
$("#btn-redo").onclick = redo;
$("#btn-fit").onclick = fitView;
$("#btn-reset").onclick = () => guard("Reset", async () => {
  const keep = { crop: S.params.crop, mode: S.params.mode, lighting: S.params.lighting };
  const r = await api("levels", { params: { ...keep } });
  S.params = r.params; syncControls(); render(); drawCurve(); commit();
});
$("#btn-export").onclick = () => guard("Export", async () => {
  const r = await api("export", { params: S.params, samples: S.samples, history: [] });
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
  if ((ev.metaKey || ev.ctrlKey) && (k === "=" || k === "+" || k === "-" || k === "0")) {
    ev.preventDefault();
    if (k === "0") fitView(); else zoomAt(imgCanvas.clientWidth / 2, imgCanvas.clientHeight / 2, k === "-" ? 1 / 1.5 : 1.5);
    return;
  }
  if (ev.metaKey || ev.ctrlKey) return;
  if (!$("#variants").hidden) {
    if (k === "escape") closeVariants();
    else if (k === " ") { ev.preventDefault(); enlargeCell(true); }
    else if (/^[1-9]$/.test(k)) openVariants(+k - 1);
    return;
  }
  if (k === "escape") { if (ST.base) closeStraighten(false); else setTool("probe"); return; }
  if (k === "\\") { compare(true); return; }
  if (k === "[") { setWidth(S.width * 0.85); return; }
  if (k === "]") { setWidth(S.width / 0.85); return; }
  if (k === "0") { fitView(); return; }
  const tools = { p: "probe", c: "push", l: "light", n: "neutral", w: "white", k: "black", s: "skin", r: "crop" };
  if (tools[k]) setTool(tools[k]);
  if (k === "v") openVariants();
});
window.addEventListener("keyup", (ev) => {
  if (ev.key === "\\") compare(false);
  if (ev.key === " ") enlargeCell(false);
});
window.addEventListener("resize", () => { sizeCanvases(); clampView(); drawImage(); });
// keep the browser from zooming the whole page on pinch outside the image
window.addEventListener("wheel", (ev) => { if (ev.ctrlKey) ev.preventDefault(); }, { passive: false });
document.addEventListener("gesturestart", (ev) => ev.preventDefault());

// ---------------------------------------------------------------- start
async function load(name) {
  const d = await api("load", { name });
  S.doc = d; S.params = d.params; S.samples = d.samples || []; S.undo = []; S.redo = []; S.probes = [];
  S.lastCommitted = snapshot();
  $("#file").innerHTML = d.files.map((f) => `<option${f === d.name ? " selected" : ""}>${f}</option>`).join("");
  $("#lighting").innerHTML = d.lighting_options.map((o) => `<option>${o}</option>`).join("");
  location.hash = encodeURIComponent(d.name);
  document.title = d.name + " · filmneg";
  S.view = { scale: 1, cx: 0.5, cy: 0.5 }; detail = null;
  syncControls(); setCurve(S.curve); setTool("probe"); renderSamples(); refreshReport();
  status(`${d.name} · ${d.width}×${d.height} · ${d.profile || "no profile, assuming sRGB"}`, 6000);
  render();
}

sizeCanvases();
load(decodeURIComponent(location.hash.slice(1)) || null);
