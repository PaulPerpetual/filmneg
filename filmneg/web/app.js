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
  falloff: 0.12,      // soft-edit width on the tone axis
  probe: null,        // last probe result + position
  push: null,         // active colour push gesture
  undo: [], redo: [],
  variants: null,     // {state, cells}
  comparing: false,
};

// ---------------------------------------------------------------- server
async function api(route, body = {}) {
  const res = await fetch("/api/" + route, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
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

// ---------------------------------------------------------------- rendering
const imgCanvas = $("#image"), overlay = $("#overlay");
let current = null;    // ImageBitmap of the latest render
let currentFull = false; // whether it shows the uncropped scan (crop tool)
let inflight = false, dirty = false;

function viewParams() {
  const p = clone(S.params);
  if (S.tool === "crop") p.crop = [0, 0, 1, 1];
  return p;
}

async function render() {
  if (inflight) { dirty = true; return; }
  inflight = true; dirty = false;
  try {
    const full = S.tool === "crop";
    const res = await fetch("/api/render", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params: viewParams(), original: S.comparing }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    current = await createImageBitmap(await res.blob(), { colorSpaceConversion: "default" });
    currentFull = full;
    drawImage();
    drawScopes();
  } catch (e) { status("render failed: " + e.message, 8000); }
  inflight = false;
  if (dirty) render();
}

function fitRect() {
  const W = imgCanvas.clientWidth, H = imgCanvas.clientHeight;
  if (!current) return { x: 0, y: 0, w: W, h: H };
  const s = Math.min(W / current.width, H / current.height) * 0.96;
  const w = current.width * s, h = current.height * s;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

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
  ctx.drawImage(current, r.x, r.y, r.w, r.h);
  drawOverlay();
}

// Shown box (in full-scan fractions) and conversions to/from screen points.
function shownBox() { return currentFull ? [0, 0, 1, 1] : S.params.crop; }

function toScan(ev) {
  const b = overlay.getBoundingClientRect(), r = fitRect(), c = shownBox();
  const u = (ev.clientX - b.left - r.x) / r.w, v = (ev.clientY - b.top - r.y) / r.h;
  return { x: c[0] + u * (c[2] - c[0]), y: c[1] + v * (c[3] - c[1]), inside: u >= 0 && u <= 1 && v >= 0 && v <= 1 };
}

function toScreen(x, y) {
  const r = fitRect(), c = shownBox();
  return { x: r.x + (x - c[0]) / (c[2] - c[0]) * r.w, y: r.y + (y - c[1]) / (c[3] - c[1]) * r.h };
}

function radiusPx(rFrac) {
  const r = fitRect(), c = shownBox(), W = S.doc.width, H = S.doc.height;
  return rFrac * Math.max(W, H) * r.w / ((c[2] - c[0]) * W);
}

// ---------------------------------------------------------------- overlay
const KIND_COLOR = { neutral: "#9ad", white: "#fff", black: "#000", skin: "#e9a37a" };

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

  S.samples.forEach((s, i) => {
    const p = toScreen(s.x, s.y), rad = Math.max(radiusPx(s.r), 3);
    ctx.lineWidth = 2;
    ctx.strokeStyle = s.kind === "black" ? "#fff" : "#000";
    ctx.beginPath(); ctx.arc(p.x, p.y, rad + 1.5, 0, 7); ctx.stroke();
    ctx.strokeStyle = KIND_COLOR[s.kind];
    ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 7); ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.font = "11px sans-serif";
    ctx.fillText(String(i + 1), p.x + rad + 4, p.y - rad);
  });

  if (S.probe && S.tool === "probe") {
    const p = toScreen(S.probe.at.x, S.probe.at.y), rad = Math.max(radiusPx(S.probe.at.r), 3);
    ctx.setLineDash([3, 3]); ctx.strokeStyle = "#fff"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 7); ctx.stroke(); ctx.setLineDash([]);
  }

  if (S.push) drawWheel(ctx);
}

// Colour wheel for the push tool. Right = magenta, up = yellow, left = green, down = blue,
// the same directions as the Colour curve panel and the vectorscope.
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

// ---------------------------------------------------------------- image interaction
const PUSH_GAIN = 0.03;     // curve delta at 150 px drag
const PUSH_CURVE = 1.6;     // >1: very gentle near the centre, stronger further out

function pushAmount(dx, dy, fine) {
  const d = Math.hypot(dx, dy);
  if (d < 2) return [0, 0];
  const a = PUSH_GAIN * Math.pow(d / 150, PUSH_CURVE) * (fine ? 0.25 : 1);
  return [a * dx / d, a * -dy / d]; // [tint (right = magenta), warmth (up = yellow)]
}

overlay.addEventListener("mousedown", async (ev) => {
  if (!S.doc) return;
  const p = toScan(ev);
  const tool = S.tool;

  if (tool === "crop") {
    S.cropStart = p; S.cropDrag = [p.x, p.y, p.x, p.y]; return;
  }
  if (!p.inside) return;

  if (["neutral", "white", "black", "skin"].includes(tool)) {
    const hit = S.samples.findIndex((s) => Math.hypot(toScreen(s.x, s.y).x - ev.offsetX, toScreen(s.x, s.y).y - ev.offsetY) < Math.max(radiusPx(s.r), 6));
    if (ev.shiftKey && hit >= 0) S.samples.splice(hit, 1);
    else S.samples.push({ kind: tool, x: p.x, y: p.y, r: +$("#radius").value });
    drawOverlay(); renderSamples(); commit();
    return;
  }

  if (tool === "probe") { await doProbe(p); return; }

  if (tool === "push") {
    const at = { x: p.x, y: p.y, r: 0.006 };
    S.push = { sx: ev.offsetX, sy: ev.offsetY, cx: ev.offsetX, cy: ev.offsetY, tone: null,
               base: clone(S.params.curves), sigma: S.falloff };
    drawOverlay();
    const pr = await api("probe", { params: S.params, at });
    if (S.push) { S.push.tone = pr.tone; S.probe = { ...pr, at }; drawCurve(); }
  }
});

window.addEventListener("mousemove", (ev) => {
  if (S.cropStart) {
    const p = toScan(ev), a = S.cropStart, cl = (v) => Math.min(Math.max(v, 0), 1);
    S.cropDrag = [cl(Math.min(a.x, p.x)), cl(Math.min(a.y, p.y)), cl(Math.max(a.x, p.x)), cl(Math.max(a.y, p.y))];
    drawOverlay(); return;
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
  if (P.tone == null) return;
  const [tint, warm] = pushAmount(P.cx - P.sx, P.cy - P.sy, fine);
  S.params.curves.warmth = addTo(P.base.warmth, bump(P.tone, warm, P.sigma));
  S.params.curves.tint = addTo(P.base.tint, bump(P.tone, tint, P.sigma));
  const deg = Math.round(Math.atan2(-(P.cy - P.sy), P.cx - P.sx) * 180 / Math.PI);
  hint(`push at tone ${(P.tone * 100).toFixed(0)}%: warmth ${fmt(warm * 255)}, tint ${fmt(tint * 255)} (scroll: width ${P.sigma.toFixed(2)}, ⌥ finer)`);
  render(); drawCurve();
}

window.addEventListener("mouseup", () => {
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
    S.push = null; hint(""); drawOverlay();
    if (changed) commit();
  }
});

overlay.addEventListener("wheel", (ev) => {
  if (!S.push) return;
  ev.preventDefault();
  S.push.sigma = Math.min(0.4, Math.max(0.04, S.push.sigma * (ev.deltaY > 0 ? 1.1 : 0.9)));
  S.falloff = S.push.sigma;
  applyPush(ev.altKey);
}, { passive: false });

async function doProbe(p) {
  const at = { x: p.x, y: p.y, r: +$("#radius").value };
  const pr = await api("probe", { params: S.params, at });
  S.probe = { ...pr, at };
  showProbe(); drawOverlay(); drawCurve();
}

function hint(t) { $("#hint").textContent = t; }
const fmt = (v, d = 1) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d);

function castWords(a, b) {
  const parts = [];
  if (Math.abs(b) > 0.003) parts.push(b > 0 ? "yellow" : "blue");
  if (Math.abs(a) > 0.003) parts.push(a > 0 ? "magenta" : "green");
  return parts.length ? "leans " + parts.join(" + ") : "neutral";
}

function showProbe() {
  const p = S.probe;
  const rgb = (v) => v.map((x) => Math.round(x * 255)).join(" / ");
  $("#probe").innerHTML = `<table>
    <tr><td>scan</td><td>${rgb(p.input)}</td></tr>
    <tr><td>now</td><td>${rgb(p.output)}</td></tr>
    <tr><td>tone</td><td>${(p.tone * 100).toFixed(0)}%</td></tr>
    <tr><td>cast</td><td>a ${fmt(p.a * 1000)} · b ${fmt(p.b * 1000)} · ${castWords(p.a, p.b)}</td></tr>
    <tr><td>skin hue</td><td>${fmt(p.skin_hue_off, 0)}° from the skin line</td></tr></table>`;
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

function curveGeom() {
  const W = curveCanvas.width, H = curveCanvas.height, pad = 14;
  return { W, H, pad, x: (t) => pad + t * (W - 2 * pad), y: (v) => H / 2 - (v / S.zoom) * (H / 2 - pad),
           t: (px) => (px - pad) / (W - 2 * pad), v: (py) => -(py - H / 2) / (H / 2 - pad) * S.zoom };
}

function drawCurve() {
  if (!S.params) return;
  const ctx = curveCanvas.getContext("2d"), g = curveGeom();
  ctx.clearRect(0, 0, g.W, g.H);

  // zone bands (II..VIII) and grid
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
  ctx.fillText(`+${Math.round(S.zoom * 255)}`, 2, 10); ctx.fillText(`−${Math.round(S.zoom * 255)}`, 2, g.H - 14);

  // falloff preview under the cursor
  if (S.hoverT != null && !S.curveDrag) {
    ctx.fillStyle = "rgba(255,255,255,.05)";
    for (let px = 0; px < g.W; px += 2) {
      const w = Math.exp(-0.5 * ((g.t(px) - S.hoverT) / S.falloff) ** 2);
      ctx.fillRect(px, g.H / 2 - w * (g.H / 2 - g.pad), 2, 2 * w * (g.H / 2 - g.pad));
    }
  }

  const names = S.curve === "colour" ? ["warmth", "tint"] : [S.curve];
  if (S.curve === "colour") {
    ctx.fillStyle = "#888"; ctx.textAlign = "right";
    ctx.fillStyle = CURVE_COLORS.warmth; ctx.fillText("warmth: yellow ↑ blue ↓", g.W - 6, 16);
    ctx.fillStyle = CURVE_COLORS.tint; ctx.fillText("tint: magenta ↑ green ↓", g.W - 6, 32);
  }
  for (const name of names) {
    const ctrl = S.params.curves[name];
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
    ctx.strokeStyle = CURVE_COLORS[name]; ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach(([t, v], i) => (i ? ctx.lineTo(g.x(t), g.y(v)) : ctx.moveTo(g.x(t), g.y(v))));
    ctx.stroke();
    // control points (off the curve, like NURBS hulls)
    ctx.fillStyle = CURVE_COLORS[name] + "99";
    ctrl.forEach((v, i) => { ctx.beginPath(); ctx.arc(g.x(CTRL_POS[i]), g.y(v), 2, 0, 7); ctx.fill(); });
  }

  // where the probed / pushed area sits on the curve(s)
  if (S.probe) {
    const marks = S.curve === "colour" || S.curve === "lightness"
      ? (S.curve === "lightness" ? [["r", S.probe.output[0]], ["g", S.probe.output[1]], ["b", S.probe.output[2]]] : [["lightness", S.probe.tone]])
      : [[S.curve, S.probe.output["rgb".indexOf(S.curve)]]];
    for (const [c, t] of marks) {
      ctx.strokeStyle = c === "lightness" ? "#fff" : CURVE_COLORS[c]; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(g.x(t), 0); ctx.lineTo(g.x(t), g.H); ctx.stroke(); ctx.setLineDash([]);
    }
    if (S.curve === "colour") {
      // small cast arrow at the probed tone: x = tint (a), y = warmth (b)
      const x = g.x(S.probe.tone), y = g.y(0), k = (g.H / 2 - g.pad) / 0.03;
      const cl = (v) => Math.max(-0.03, Math.min(0.03, v));
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y);
      ctx.lineTo(x + cl(S.probe.a) * k, y - cl(S.probe.b) * k); ctx.stroke();
    }
  }
}

curveCanvas.addEventListener("mousedown", (ev) => {
  const g = curveGeom(), sc = curveCanvas.width / curveCanvas.clientWidth;
  S.curveDrag = { t: g.t(ev.offsetX * sc), x0: ev.offsetX, y0: ev.offsetY, base: clone(S.params.curves) };
});

window.addEventListener("mousemove", (ev) => {
  const g = curveGeom(), sc = curveCanvas.width / curveCanvas.clientWidth;
  if (!S.curveDrag) {
    if (ev.target === curveCanvas) { S.hoverT = g.t(ev.offsetX * sc); drawCurve(); }
    return;
  }
  const D = S.curveDrag, b = curveCanvas.getBoundingClientRect();
  const gain = ev.altKey ? 0.2 : ev.shiftKey ? 3 : 1;
  const perPx = (S.zoom * 2) / (g.H - 2 * g.pad) * sc * 0.5 * gain;
  const dy = -(ev.clientY - b.top - D.y0) * perPx, dx = (ev.clientX - b.left - D.x0) * perPx;
  if (S.curve === "colour") {
    S.params.curves.warmth = addTo(D.base.warmth, bump(D.t, dy, S.falloff));
    S.params.curves.tint = addTo(D.base.tint, bump(D.t, dx, S.falloff));
  } else {
    S.params.curves[S.curve] = addTo(D.base[S.curve], bump(D.t, dy, S.falloff));
  }
  drawCurve(); render();
});

window.addEventListener("mouseup", () => { if (S.curveDrag) { S.curveDrag = null; commit(); } });
curveCanvas.addEventListener("mouseleave", () => { S.hoverT = null; drawCurve(); });
curveCanvas.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  S.falloff = Math.min(0.4, Math.max(0.04, S.falloff * (ev.deltaY > 0 ? 1.1 : 0.9)));
  drawCurve();
}, { passive: false });
curveCanvas.addEventListener("dblclick", () => {
  for (const n of S.curve === "colour" ? ["warmth", "tint"] : [S.curve]) S.params.curves[n] = Array(N_CTRL).fill(0);
  drawCurve(); render(); commit();
});

// ---------------------------------------------------------------- scopes (from the preview pixels)
const scratch = document.createElement("canvas");

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
  if (!current) return;
  const w = 300, h = Math.max(1, Math.round(current.height * w / current.width));
  scratch.width = w; scratch.height = h;
  const sctx = scratch.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(current, 0, 0, w, h);
  const px = sctx.getImageData(0, 0, w, h).data;

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
    const [L, a, b] = srgbToOklab(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
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
  cctx.fillText("yellow / magenta ↑", 3, 10);
}

const SKIN_HUE = (() => {
  const skins = [[255, 219, 172], [224, 172, 140], [198, 134, 103], [160, 110, 80], [141, 85, 36], [105, 60, 40]];
  let sx = 0, sy = 0;
  for (const [r, g, b] of skins) { const [, a, bb] = srgbToOklab(r / 255, g / 255, b / 255); const h = Math.atan2(bb, a); sx += Math.cos(h); sy += Math.sin(h); }
  return Math.atan2(sy, sx);
})();

// ---------------------------------------------------------------- variants (ring-around)
async function openVariants(pick = null) {
  $("#variants").hidden = false;
  $("#vinfo").textContent = "rendering…";
  const body = { params: S.params, state: S.variants?.state || null };
  if (pick !== null) { body.pick = pick; body.cells = S.variants.cells.map(({ image, ...c }) => c); }
  try {
    const res = await api("variants", body);
    S.variants = { state: res.state, cells: res.cells };
    if (pick !== null) { S.params = res.params; commit(); syncControls(); render(); drawCurve(); }
    const g = $("#vgrid"); g.innerHTML = "";
    res.cells.forEach((c, i) => {
      const d = document.createElement("div");
      d.className = "cell" + (i === 4 ? " center" : "");
      d.innerHTML = `<img src="${c.image}"><span class="label">${c.label}</span>`;
      d.onclick = () => openVariants(i);
      g.appendChild(d);
    });
    $("#vinfo").textContent = `generation ${res.state.generation} · step ${res.state.step.toFixed(2)} · click the one you like best (centre = keep, look closer)`;
  } catch (e) { status("variants failed: " + e.message, 8000); }
}

function closeVariants() { $("#variants").hidden = true; S.variants = null; }

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
    S.params[k] = +el.value; el.nextElementSibling.textContent = (+el.value).toFixed(2); render();
  });
  el.addEventListener("change", commit);
  el.addEventListener("dblclick", () => { S.params[k] = k === "exposure" || k === "nr" ? 0 : 1; syncControls(); render(); commit(); });
}
$("#lighting").addEventListener("change", (e) => { S.params.lighting = e.target.value; commit(); });

function setTool(t) {
  S.tool = t;
  $$("#tools [data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
  overlay.style.cursor = t === "push" ? "move" : "crosshair";
  if (t === "crop" || currentFull) render(); else drawOverlay();
  hint({ push: "click a spot, then drag towards a colour; further = stronger", crop: "drag the new crop" }[t] || "");
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
  curveCanvas.style.cursor = c === "colour" ? "move" : "ns-resize";
  $("#curve-help").textContent = c === "colour" ? "drag ↑↓ warmth, ←→ tint" : "";
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
$("#btn-straighten").onclick = () => guard("Straighten", async () => {
  S.params = (await api("straighten", { params: S.params })).params; render(); drawCurve(); commit(); setCurve("colour");
});
$("#btn-variants").onclick = () => openVariants();
$("#v-keep").onclick = closeVariants;
$("#btn-undo").onclick = undo;
$("#btn-redo").onclick = redo;
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
  if (ev.metaKey || ev.ctrlKey) return;
  if (k === "escape") { if (!$("#variants").hidden) closeVariants(); else setTool("probe"); return; }
  if (k === "\\") { compare(true); return; }
  const tools = { p: "probe", c: "push", n: "neutral", w: "white", k: "black", s: "skin", r: "crop" };
  if (tools[k]) setTool(tools[k]);
  if (k === "v") $("#variants").hidden ? openVariants() : closeVariants();
});
window.addEventListener("keyup", (ev) => { if (ev.key === "\\") compare(false); });
window.addEventListener("resize", () => { sizeCanvases(); drawImage(); });

// ---------------------------------------------------------------- start
async function load(name) {
  const d = await api("load", { name });
  S.doc = d; S.params = d.params; S.samples = d.samples || []; S.undo = []; S.redo = []; S.probe = null;
  S.lastCommitted = snapshot();
  $("#file").innerHTML = d.files.map((f) => `<option${f === d.name ? " selected" : ""}>${f}</option>`).join("");
  $("#lighting").innerHTML = d.lighting_options.map((o) => `<option>${o}</option>`).join("");
  location.hash = d.name;
  document.title = d.name + " · filmneg";
  syncControls(); setCurve(S.curve); setTool("probe"); renderSamples(); refreshReport();
  status(`${d.name} · ${d.width}×${d.height} · ${d.profile || "no profile, assuming sRGB"}`, 6000);
  render();
}

sizeCanvases();
load(decodeURIComponent(location.hash.slice(1)) || null);
