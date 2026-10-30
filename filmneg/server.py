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

from . import analysis, imageio, pipeline, variants

WEB = Path(__file__).parent / "web"
PREVIEW = 1600
THUMB = 520
SCAN_EXT = {".tif", ".tiff", ".jpg", ".jpeg", ".png"}


def sidecar_path(path: Path):
    return path.with_name(path.name + ".filmneg.json")


class Session:
    def __init__(self, root: Path):
        self.root = root
        self.lock = threading.Lock()
        self.scan = None
        self._nr_cache = {}

    def files(self):
        folder = self.root if self.root.is_dir() else self.root.parent
        return sorted(p.name for p in folder.iterdir()
                      if p.suffix.lower() in SCAN_EXT and "_filmneg" not in p.stem)

    def folder(self):
        return self.root if self.root.is_dir() else self.root.parent

    def load(self, name):
        path = self.folder() / name
        self.scan = imageio.load(path)
        self._nr_cache = {}
        self.proxies = {
            "preview": imageio.downsample(self.scan.rgb, PREVIEW),
            "thumb": imageio.downsample(self.scan.rgb, THUMB),
        }
        side = sidecar_path(path)
        if side.exists():
            doc = json.loads(side.read_text())
            doc["params"] = pipeline.normalize(doc.get("params"))
        else:
            params = pipeline.default_params()
            params["crop"] = analysis.auto_crop(self.proxies["preview"])
            params["black"], params["white"] = analysis.auto_levels(
                self.proxies["preview"], params, self.scan.space)
            doc = {"params": params, "samples": [], "history": []}
        h, w = self.scan.rgb.shape[:2]
        doc.update(name=name, width=w, height=h, profile=self.scan.profile_name,
                   space=self.scan.space.name, files=self.files(),
                   lighting_options=list(analysis.LIGHTING))
        return doc

    def source(self, size, params):
        """The input at a given size, chroma-denoised if asked, cached per strength."""
        nr = round(float(params.get("nr", 0)), 3)
        key = (size, nr)
        if key not in self._nr_cache:
            base = self.scan.rgb if size == "full" else self.proxies[size]
            self._nr_cache[key] = pipeline.chroma_denoise(base, nr, self.scan.space)
        return self._nr_cache[key]

    def render(self, params, size="preview", cropped=True, original=False):
        params = pipeline.normalize(params)
        src = self.source(size, params) if not original else (
            self.scan.rgb if size == "full" else self.proxies[size])
        if cropped:
            src = pipeline.crop(src, params["crop"])
        if original:
            return src
        return pipeline.render_pixels(src, params, self.scan.space)

    def sample_colors(self, samples, params):
        """Sample positions are fractions of the whole scan, so they survive re-cropping."""
        src = self.source("preview", params)
        return [analysis.sample_color(src, s) for s in samples]

    def save(self, doc):
        side = sidecar_path(self.scan.path)
        keep = {k: doc[k] for k in ("params", "samples", "history") if k in doc}
        side.write_text(json.dumps(keep, indent=1))
        return str(side)

    def export(self, params):
        out = self.render(params, size="full")
        path = self.scan.path.with_name(self.scan.path.stem + "_filmneg.tif")
        imageio.save_tiff16(path, out, self.scan.icc)
        return str(path)


def make_handler(session: Session):
    def jpeg_b64(rgb):
        return "data:image/jpeg;base64," + base64.b64encode(imageio.to_jpeg(rgb, session.scan.icc, 85)).decode()

    def api(route, body):
        p = pipeline.normalize(body.get("params")) if "params" in body else None
        s = session
        if route == "load":
            return s.load(body.get("name") or s.files()[0])
        if route == "auto":
            p["crop"] = analysis.auto_crop(s.proxies["preview"])
            p["black"], p["white"] = analysis.auto_levels(s.proxies["preview"], p, s.scan.space)
            return {"params": p}
        if route == "levels":
            p["black"], p["white"] = analysis.auto_levels(s.proxies["preview"], p, s.scan.space)
            return {"params": p}
        if route == "solve":
            samples = body.get("samples", [])
            colors = s.sample_colors(samples, p)
            kinds = [x["kind"] for x in samples]
            if samples:
                p = analysis.solve(colors, kinds, p, s.scan.space)
            return {"params": p, "report": analysis.sample_report(colors, kinds, p, s.scan.space) if samples else []}
        if route == "report":
            samples = body.get("samples", [])
            colors = s.sample_colors(samples, p)
            return {"report": analysis.sample_report(colors, [x["kind"] for x in samples], p, s.scan.space) if samples else []}
        if route == "straighten":
            src = pipeline.crop(s.source("thumb", p), p["crop"])
            return {"params": analysis.straighten(src, p, s.scan.space, float(body.get("strength", 1.0)))}
        if route == "probe":
            src = s.source("preview", p)
            out = pipeline.render_pixels(src, p, s.scan.space)
            return analysis.probe(src, out, body["at"], p, s.scan.space)
        if route == "variants":
            state = body.get("state") or variants.new_state()
            if body.get("pick") is not None:
                state = variants.pick(state, body["cells"], int(body["pick"]))
                p = pipeline.normalize(body["cells"][int(body["pick"])]["params"])
            cells = variants.generate(p, state)
            for c in cells:
                c["image"] = jpeg_b64(s.render(c["params"], "thumb"))
            return {"state": state, "cells": cells, "params": p}
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
                                             original=bool(body.get("original")))
                        return self._send(200, imageio.to_jpeg(rgb, session.scan.icc, 90), "image/jpeg")
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
    session.load(first)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(session))
    url = f"http://127.0.0.1:{args.port}/#{first}"
    print(f"filmneg running at {url}  (Ctrl-C to stop)")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
