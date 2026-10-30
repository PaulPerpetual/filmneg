"""Local web app: a tiny HTTP server plus the session state for one open scan.

Run with `filmneg path/to/scan.tif` or `filmneg path/to/folder`.
"""
import argparse
import base64
import json
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

from . import analysis, color, curves, dust, imageio, pipeline

WEB = Path(__file__).parent / "web"
PREVIEW = 1600
DRAG = 800      # lighter preview while a slider or curve is being dragged
THUMB = 520
CLIP_VIEW = 1100  # the browser draws the clipping overlay from a copy of the image before levels
LIVE = 1100       # the browser's live preview while dragging
REGION = 2000   # zoomed-in detail is rendered from full resolution, up to this size
LUT_N = 4096
SCAN_EXT = {".tif", ".tiff", ".jpg", ".jpeg", ".png"}


def sidecar_path(path: Path):
    return path.with_name(path.name + ".filmneg.json")


class Session:
    def __init__(self, root: Path):
        self.root = root
        self.lock = threading.Lock()
        self.scan = None
        self._nr_cache = {}
        self.dust = {"spots": [], "threshold": 0.6, "repair": True}
        self._patches = {}  # size -> {spot id: repairs at that size}
        self._healed = {}   # size -> (key, image with the repairs)

    def files(self):
        folder = self.root if self.root.is_dir() else self.root.parent
        return sorted(p.name for p in folder.iterdir()
                      if p.suffix.lower() in SCAN_EXT and "_filmneg" not in p.stem)

    def folder(self):
        return self.root if self.root.is_dir() else self.root.parent

    def load(self, name):
        path = self.folder() / name
        self.scan = imageio.load(path)
        self._nr_cache, self._patches, self._healed = {}, {}, {}
        self.proxies = {
            "preview": imageio.downsample(self.scan.rgb, PREVIEW),
            "drag": imageio.downsample(self.scan.rgb, DRAG),
            "thumb": imageio.downsample(self.scan.rgb, THUMB),
        }
        side = sidecar_path(path)
        if side.exists():
            doc = json.loads(side.read_text())
            doc["params"] = pipeline.normalize(doc.get("params"))
            if doc.pop("auto_pending", False):  # settings were pasted before this frame was ever opened
                params = doc["params"]
                params["crop"] = analysis.auto_crop(self.proxies["preview"])
                params["black"], params["white"] = analysis.auto_levels(self.proxies["preview"], params, self.scan.space)
                side.write_text(json.dumps(doc, indent=1))
        else:
            params = pipeline.default_params()
            params["crop"] = analysis.auto_crop(self.proxies["preview"])
            params["black"], params["white"] = analysis.auto_levels(
                self.proxies["preview"], params, self.scan.space)
            doc = {"params": params, "samples": [], "history": []}
        self.dust = {"spots": [], "threshold": 0.6, "repair": True, **doc.get("dust", {})}
        h, w = self.scan.rgb.shape[:2]
        doc["dust"] = self.dust_view(doc["params"])
        doc.update(name=name, width=w, height=h, profile=self.scan.profile_name,
                   space=self.scan.space.name, files=self.files(),
                   lighting_options=list(analysis.LIGHTING))
        return doc

    def source(self, size, params, nr=True):
        """The input at a given size, rotated and chroma-denoised as asked.

        Cached per size; only the latest strength and angle are kept per size.
        """
        strength = round(float(params.get("nr", 0)), 3) if nr else 0.0
        angle = (round(float(params.get("angle", 0)), 2), round(float(params.get("distortion", 0)), 2))
        heal_key, base = self.healed_base(size) if nr else ((), self.raw(size))
        key = (size, strength, angle, heal_key)
        if key not in self._nr_cache:
            for k in [k for k in self._nr_cache if k[0] == size and (k[2:] != key[2:] or len(self._nr_cache) > 8)]:
                del self._nr_cache[k]
            self._nr_cache[key] = pipeline.chroma_denoise(pipeline.geometry(base, *angle), strength, self.scan.space)
        return self._nr_cache[key]

    def raw(self, size):
        return self.scan.rgb if size == "full" else self.proxies[size]

    # ------------------------------------------------------------ dust
    def dust_on(self):
        d = self.dust
        return dust.healed(d["spots"], d["threshold"]) if d["repair"] else []

    def healed_base(self, size):
        """(key, the scan at this size with the chosen dust repaired). Repairs are
        computed once per spot and size, so switching one on or off is quick."""
        on = self.dust_on()
        key = tuple(sorted(s["id"] for s in on))
        if self._healed.get(size, (None,))[0] != key:
            raw = self.raw(size)
            done = self._patches.setdefault(size, {})
            todo = [s for s in on if s["id"] not in done]
            if todo:
                avoid = [s for s in self.dust["spots"] if s["conf"] >= 0.2 or s.get("on")]
                done.update(dust.patches(raw, todo, avoid))
            self._healed[size] = (key, dust.apply(raw, [p for s in on for p in done.get(s["id"], [])]))
        return self._healed[size]

    def dust_changed(self, new_spots=False):
        if new_spots:
            self._patches = {}
        self._healed = {}
        side = sidecar_path(self.scan.path)
        doc = json.loads(side.read_text()) if side.exists() else {}
        doc["dust"] = self.dust
        side.write_text(json.dumps(doc, indent=1))

    def dust_view(self, params):
        """The dust state for the browser, with each spot's place in the straightened view."""
        H, W = self.scan.rgb.shape[:2]
        on = {s["id"] for s in dust.healed(self.dust["spots"], self.dust["threshold"])}
        out = []
        for s in self.dust["spots"]:
            x0, y0, x1, y1 = s["box"]
            u, v = pipeline.geometry_point((x0 + x1) / 2, (y0 + y1) / 2, W, H, params["angle"], params["distortion"])
            r = max((x1 - x0) * W, (y1 - y0) * H) / 2 / max(W, H)
            out.append({"id": s["id"], "x": u, "y": v, "r": r, "conf": s["conf"], "kind": s.get("kind", "speck"),
                        "px": round(max((x1 - x0) * W, (y1 - y0) * H)),
                        "on": s.get("on"), "healed": s["id"] in on})
        return {"spots": out, "threshold": self.dust["threshold"], "repair": self.dust["repair"]}

    def dust_mask(self, params):
        """A mask of the marked dust, lined up with the exported TIFF."""
        from PIL import Image
        H, W = self.scan.rgb.shape[:2]
        m = dust.mask_image(dust.healed(self.dust["spots"], self.dust["threshold"]), H, W)
        m = pipeline.geometry(m[..., None].astype(np.float32), params["angle"], params["distortion"])
        m = pipeline.crop(m, params["crop"])[..., 0]
        path = self.scan.path.with_name(self.scan.path.stem + "_filmneg_dust.png")
        Image.fromarray(np.where(m > 127, 255, 0).astype(np.uint8)).save(path)
        return str(path)

    def render(self, params, size="preview", cropped=True, original=False, region=None):
        """region (fractions of the cropped image) renders that part from full resolution."""
        params = pipeline.normalize(params)
        if region:
            size = "full"
        src = self.source(size, params, nr=not original)
        if cropped:
            src = pipeline.crop(src, params["crop"])
        if region:
            src = imageio.downsample(pipeline.crop(src, region), REGION)
        if original:
            return src
        return pipeline.render_pixels(src, params, self.scan.space)

    def sample_colors(self, samples, params):
        """Sample positions are fractions of the whole scan, so they survive re-cropping."""
        src = self.source("preview", params)
        return [analysis.sample_color(src, s) for s in samples]

    def space_info(self):
        sp = self.scan.space
        lms = color._OKLAB_M1 @ sp.to_xyz
        return {
            "gamma": sp.gamma,  # None: the sRGB curve
            "lin_to_lms": lms.tolist(), "lms_to_lin": np.linalg.inv(lms).tolist(),
            "m2": color._OKLAB_M2.tolist(), "m2_inv": np.linalg.inv(color._OKLAB_M2).tolist(),
            "to_srgb": (np.linalg.inv(color.SRGB.to_xyz) @ sp.to_xyz).tolist(),
        }

    def casts(self, colors, kinds, report, params):
        out = pipeline.render_pixels(pipeline.crop(self.source("thumb", params), params["crop"]), params, self.scan.space)
        return analysis.cast_report(out, colors, kinds, report, params, self.scan.space)

    def save(self, doc):
        side = sidecar_path(self.scan.path)
        keep = {k: doc[k] for k in ("params", "samples", "versions", "history") if k in doc}
        keep["dust"] = self.dust
        side.write_text(json.dumps(keep, indent=1))
        return str(side)

    def export(self, params):
        out = self.render(params, size="full")
        path = self.scan.path.with_name(self.scan.path.stem + "_filmneg.tif")
        imageio.save_tiff16(path, out, self.scan.icc)
        return str(path)


def _unrotated_box(params, shape):
    """The crop in unrotated scan fractions (its bounding box), a little larger."""
    H, W = shape[:2]
    x0, y0, x1, y1 = params["crop"]
    pts = [pipeline.geometry_point(x, y, W, H, params["angle"], params["distortion"], inverse=True)
           for x in (x0, x1) for y in (y0, y1)]
    xs, ys = [q[0] for q in pts], [q[1] for q in pts]
    return [max(0.0, min(xs) - 0.01), max(0.0, min(ys) - 0.01), min(1.0, max(xs) + 0.01), min(1.0, max(ys) + 0.01)]


def make_handler(session: Session):
    def api(route, body):
        p = pipeline.normalize(body.get("params")) if "params" in body else None
        s = session
        if route == "load":
            return s.load(body.get("name") or s.default)
        if route == "auto":
            p["crop"] = analysis.auto_crop(pipeline.geometry(s.proxies["preview"], p["angle"], p["distortion"]))
            p["black"], p["white"] = analysis.auto_levels(pipeline.geometry(s.proxies["preview"], p["angle"], p["distortion"]), p, s.scan.space)
            return {"params": p}
        if route == "autocrop":
            return {"crop": analysis.auto_crop(pipeline.geometry(s.proxies["preview"], p["angle"], p["distortion"]))}
        if route == "levels":
            p["black"], p["white"] = analysis.auto_levels(pipeline.geometry(s.proxies["preview"], p["angle"], p["distortion"]), p, s.scan.space)
            return {"params": p}
        if route == "solve":
            samples = body.get("samples", [])
            colors = s.sample_colors(samples, p)
            kinds = [x["kind"] for x in samples]
            if samples:
                p = analysis.solve(colors, kinds, p, s.scan.space)
            report = analysis.sample_report(colors, kinds, p, s.scan.space) if samples else []
            return {"params": p, "report": report, "casts": s.casts(colors, kinds, report, p)}
        if route == "report":
            samples = body.get("samples", [])
            colors = s.sample_colors(samples, p)
            kinds = [x["kind"] for x in samples]
            report = analysis.sample_report(colors, kinds, p, s.scan.space) if samples else []
            return {"report": report, "casts": s.casts(colors, kinds, report, p)}
        if route == "probe":
            src = s.source("preview", p)
            out = pipeline.render_pixels(src, p, s.scan.space)
            return analysis.probe(src, out, body["at"], p, s.scan.space)
        if route == "probes":
            src = s.source("preview", p)
            out = pipeline.render_pixels(src, p, s.scan.space)
            return {"probes": [analysis.probe(src, out, at, p, s.scan.space) for at in body.get("at", [])]}
        if route == "histogram":
            # what the Levels panel shows: the image before levels and curves
            src = pipeline.crop(s.source("drag", p), p["crop"])
            pre = np.clip(pipeline.pre_levels(src, p, s.scan.space), 0, 1)
            bins = int(body.get("bins", 1024))
            idx = np.minimum((pre * bins).astype(np.int32), bins - 1)
            return {"bins": bins, "hist": [np.bincount(idx[..., i].ravel(), minlength=bins) for i in range(3)]}
        if route == "paste_roll":
            # write the copied settings into the other frames' sidecars; frame-specific
            # values stay, and what was there before is kept as a version
            import time
            count = 0
            for name in body.get("names", []):
                path = s.folder() / name
                if name not in s.files() or path == s.scan.path:
                    continue
                side = sidecar_path(path)
                doc = json.loads(side.read_text()) if side.exists() else {"params": {}, "auto_pending": True}
                old = pipeline.normalize(doc.get("params"))
                if side.exists():
                    doc.setdefault("versions", []).append({"name": "Before paste", "time": int(time.time() * 1000), "params": old})
                doc["params"] = {**old, **body["settings"]}
                side.write_text(json.dumps(doc, indent=1))
                count += 1
            return {"count": count}
        if route == "lut":
            # every per-channel stage as a table over the input value, plus the colour
            # maths the browser needs to finish the live preview itself
            ramp = np.repeat(np.linspace(0, 1, LUT_N, dtype=np.float32)[:, None], 3, axis=1)
            table = pipeline.channel_stages(ramp, p, s.scan.space)
            tone = ramp[:, 0]
            shifts = np.stack([curves.apply(p["curves"]["warmth"], tone),
                               curves.apply(p["curves"]["tint"], tone)], axis=1)
            pack = lambda a: base64.b64encode(np.ascontiguousarray(a, "<f4").tobytes()).decode()
            return {"n": LUT_N, "table": pack(table), "shifts": pack(shifts), "space": s.space_info()}
        if route == "dust_find":
            manual = [d for d in s.dust["spots"] if d.get("manual")]
            found = dust.find(s.scan.rgb, _unrotated_box(p, s.scan.rgb.shape))
            for i, d in enumerate(manual):
                d["id"] = len(found) + i + 1
            s.dust["spots"] = found + manual
            s.dust_changed(new_spots=True)
            return s.dust_view(p)
        if route == "dust":
            # change the dust list: switch a spot, set the threshold, add or remove a spot
            d = s.dust
            spots = {x["id"]: x for x in d["spots"]}
            if "threshold" in body:
                d["threshold"] = float(body["threshold"])
            if "repair" in body:
                d["repair"] = bool(body["repair"])
            if body.get("id") in spots and "on" in body:
                spots[body["id"]]["on"] = body["on"]
            if body.get("remove") in spots:
                d["spots"].remove(spots[body["remove"]])
            if "add" in body:  # a spot marked by hand, in the straightened view
                H, W = s.scan.rgb.shape[:2]
                a = body["add"]
                u, v = pipeline.geometry_point(a["x"], a["y"], W, H, p["angle"], p["distortion"], inverse=True)
                rx, ry = a["r"] * max(W, H) / W, a["r"] * max(W, H) / H
                d["spots"].append({"id": max(spots, default=0) + 1, "box": [u - rx, v - ry, u + rx, v + ry],
                                   "conf": 1.0, "kind": "manual", "manual": True, "on": True})
            if len(body) > 1 or "params" not in body:
                s.dust_changed()
            return s.dust_view(p)
        if route == "dust_mask":
            return {"path": s.dust_mask(p)}
        if route == "save":
            return {"path": s.save(body)}
        if route == "export":
            s.save(body)
            return {"path": s.export(p)}
        raise KeyError(route)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, code, data, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _send_rgb16(self, rgb):
            data = np.rint(np.clip(rgb, 0, 1) * 65535).astype("<u2").tobytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Size", f"{rgb.shape[1]}x{rgb.shape[0]}")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            name = self.path.split("?")[0].lstrip("/") or "index.html"
            f = (WEB / name).resolve()
            if WEB.resolve() not in f.parents or not f.is_file():
                msg = f"not found: {name} (looking in {WEB}, exists: {WEB.is_dir()})"
                return self._send(404, msg.encode(), "text/plain; charset=utf-8")
            ctype = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}.get(f.suffix, "application/octet-stream")
            self._send(200, f.read_bytes(), ctype + "; charset=utf-8")

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            route = self.path.strip("/").removeprefix("api/")
            try:
                with session.lock:
                    if route == "render":
                        rgb = session.render(body.get("params"), body.get("size", "preview"),
                                             original=bool(body.get("original")), region=body.get("region"))
                        return self._send(200, imageio.to_jpeg(rgb, session.scan.icc, 90), "image/jpeg")
                    if route == "source":
                        # the input as the browser's live preview uses it: rotated, denoised,
                        # cropped and small, 16-bit; the browser applies the edit on top
                        p = pipeline.normalize(body.get("params"))
                        src = imageio.downsample(pipeline.crop(session.source("preview", p), p["crop"]), LIVE)
                        return self._send_rgb16(src)
                    if route == "prelevels":
                        # 8-bit is too coarse to place the overlay's edge; send 16-bit RGB
                        p = pipeline.normalize(body.get("params"))
                        src = imageio.downsample(pipeline.crop(session.source("preview", p), p["crop"]), CLIP_VIEW)
                        pre = np.clip(pipeline.pre_levels(src, p, session.scan.space), 0, 1)
                        return self._send_rgb16(pre)
                    result = api(route, body)
                self._send(200, json.dumps(result, default=_jsonable).encode(), "application/json")
            except Exception as e:  # report to the UI instead of dropping the connection
                import traceback
                traceback.print_exc()
                self._send(500, json.dumps({"error": f"{type(e).__name__}: {e}"}).encode(), "application/json")

    return Handler


def _jsonable(o):
    if isinstance(o, np.generic):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(type(o))


def main(argv=None):
    ap = argparse.ArgumentParser(prog="filmneg", description="Colour correction for film scans.")
    ap.add_argument("path", help="a scan (TIFF) or a folder of scans")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args(argv)

    if not (WEB / "index.html").is_file():
        raise SystemExit(f"The web UI files are missing from {WEB}. Reinstall with: pip install -e .")
    root = Path(args.path).expanduser().resolve()
    session = Session(root)
    first = root.name if root.is_file() else (session.files() or [None])[0]
    if first is None:
        raise SystemExit(f"No scans found in {root}")
    session.default = first
    session.load(first)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(session))
    url = f"http://127.0.0.1:{args.port}/"  # no file name in the URL: spaces and # break it
    print(f"filmneg running at {url}  (Ctrl-C to stop)")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
