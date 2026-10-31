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
        self._nr_cache = {}  # (size, nr, geometry, healed?) -> (repaired spot ids, source)
        self.dust = {"spots": [], "threshold": 0.6, "repair": True, "size": [2, 150]}
        self._patches = {}  # size -> {spot id: repairs at that size}
        self.progress = None  # {"label", "frac"} while a long task runs, for the browser's pie

    def files(self):
        folder = self.root if self.root.is_dir() else self.root.parent
        return sorted(p.name for p in folder.iterdir()
                      if p.suffix.lower() in SCAN_EXT and "_filmneg" not in p.stem)

    def folder(self):
        return self.root if self.root.is_dir() else self.root.parent

    def load(self, name):
        path = self.folder() / name
        self.scan = imageio.load(path)
        self._nr_cache, self._patches = {}, {}
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
        self.dust = {"spots": [], "threshold": 0.6, "repair": True, "size": [2, 150], **doc.get("dust", {})}
        h, w = self.scan.rgb.shape[:2]
        doc["dust"] = self.dust_view(doc["params"])
        doc.update(name=name, width=w, height=h, profile=self.scan.profile_name,
                   space=self.scan.space.name, files=self.files(),
                   light_presets=analysis.LIGHT_PRESETS, zones=analysis.ZONES)
        return doc

    def source(self, size, params, nr=True):
        """The input at a given size, dust repaired, rotated and chroma-denoised as asked.

        Cached per size; only the latest strength and angle are kept per size.
        When only the repaired spots change, just the pixels around those spots
        are worked out again, so reviewing dust stays quick on big scans.
        """
        strength = round(float(params.get("nr", 0)), 3) if nr else 0.0
        geo = (round(float(params.get("angle", 0)), 2), round(float(params.get("distortion", 0)), 2))
        key = (size, strength, geo, nr)
        ids = frozenset(x["id"] for x in self.dust_on()) if nr else frozenset()
        hit = self._nr_cache.get(key)
        if hit and hit[0] != ids and len(hit[0] ^ ids) <= 400:
            changed = hit[0] ^ ids
            self._ensure_patches(size, ids)
            out = hit[1]
            for win in self._spot_windows(size, changed, geo):
                y0, y1, x0, x1 = win
                out[y0:y1, x0:x1] = self._window(size, win, ids, strength, geo)
            hit = self._nr_cache[key] = (ids, out)
        if not hit or hit[0] != ids:
            for k in [k for k in self._nr_cache if k[0] == size]:
                del self._nr_cache[k]
            base = self.healed_base(size, ids) if ids else self.raw(size)
            arr = pipeline.chroma_denoise(pipeline.geometry(base, *geo), strength, self.scan.space)
            if arr is self.raw(size):
                arr = np.array(arr, np.float32, copy=True)  # updated in place later
            hit = self._nr_cache[key] = (ids, arr)
        return hit[1]

    def _ensure_patches(self, size, ids):
        done = self._patches.setdefault(size, {})
        todo = [x for x in self.dust["spots"] if x["id"] in ids and x["id"] not in done]
        if todo:
            avoid = [x for x in self.dust["spots"] if x["conf"] >= 0.2 or x.get("on")]
            big = len(todo) > 40
            done.update(dust.patches(self.raw(size), todo, avoid,
                                     progress=(lambda f: self.task("Repairing dust", f)) if big else None))
            self.task("", 1)
        return done

    def _spot_windows(self, size, sids, geo):
        """Output windows (y0, y1, x0, x1) at this size that cover the given spots."""
        raw = self.raw(size)
        H, W = raw.shape[:2]
        done = self._patches.get(size, {})
        spots = {x["id"]: x for x in self.dust["spots"]}
        out = []
        for sid in sids:
            boxes = [(y0, y0 + v.shape[0], x0, x0 + v.shape[1]) for y0, x0, v, _ in done.get(sid, [])]
            if not boxes and sid in spots:
                b = spots[sid]["box"]
                boxes = [(b[1] * H, b[3] * H, b[0] * W, b[2] * W)]
            if not boxes:
                continue
            y0, y1 = min(b[0] for b in boxes) - 2, max(b[1] for b in boxes) + 2
            x0, x1 = min(b[2] for b in boxes) - 2, max(b[3] for b in boxes) + 2
            if any(geo):  # where those scan pixels land after rotation / lens correction
                pts = [pipeline.geometry_point(x / W, y / H, W, H, *geo) for y in (y0, y1) for x in (x0, x1)]
                y0, y1 = min(q[1] for q in pts) * H - 3, max(q[1] for q in pts) * H + 3
                x0, x1 = min(q[0] for q in pts) * W - 3, max(q[0] for q in pts) * W + 3
            y0, y1 = max(0, int(np.floor(y0))), min(H, int(np.ceil(y1)))
            x0, x1 = max(0, int(np.floor(x0))), min(W, int(np.ceil(x1)))
            if y0 < y1 and x0 < x1:
                out.append((y0, y1, x0, x1))
        return out

    def _window(self, size, win, ids, strength, geo):
        """One window of source() output, worked out on its own with the spots ids
        repaired: the scan pixels it needs, repairs pasted in, geometry, chroma noise."""
        from scipy.ndimage import map_coordinates
        raw = self.raw(size)
        H, W = raw.shape[:2]
        y0, y1, x0, x1 = win
        pad = 2 * pipeline.nr_radius(strength, max(H, W)) + 2 if strength > 0 else 0
        py0, py1, px0, px1 = max(0, y0 - pad), min(H, y1 + pad), max(0, x0 - pad), min(W, x1 + pad)
        if any(geo):
            yy, xx = np.mgrid[py0:py1, px0:px1].astype(np.float32)
            sy, sx = pipeline.geometry_coords(yy, xx, H, W, *geo)
            ry0, ry1 = max(0, int(np.floor(sy.min())) - 1), min(H, int(np.ceil(sy.max())) + 2)
            rx0, rx1 = max(0, int(np.floor(sx.min())) - 1), min(W, int(np.ceil(sx.max())) + 2)
        else:
            ry0, ry1, rx0, rx1 = py0, py1, px0, px1
        base = np.array(raw[ry0:ry1, rx0:rx1], np.float32, copy=True)
        done = self._patches.get(size, {})
        for sid in ids:
            for t0, l0, v, a in done.get(sid, []):
                ya, xa = max(ry0, t0), max(rx0, l0)
                yb, xb = min(ry1, t0 + v.shape[0]), min(rx1, l0 + v.shape[1])
                if ya < yb and xa < xb:
                    t = base[ya - ry0:yb - ry0, xa - rx0:xb - rx0]
                    aa = a[ya - t0:yb - t0, xa - l0:xb - l0]
                    t[...] = t * (1 - aa) + v[ya - t0:yb - t0, xa - l0:xb - l0] * aa
        if any(geo):
            if ry0 >= ry1 or rx0 >= rx1:  # entirely outside the scan
                return np.zeros((y1 - y0, x1 - x0, 3), np.float32)
            # outside the scan stays black, as in geometry(): only coordinates inside it are offset
            inside = (sy > -1) & (sy < H) & (sx > -1) & (sx < W)
            sy, sx = np.where(inside, sy - ry0, -10), np.where(inside, sx - rx0, -10)
            img = np.stack([map_coordinates(base[..., c], [sy, sx], order=1, mode="constant", cval=0.0)
                            for c in range(3)], axis=-1)
        else:
            img = base
        img = pipeline.chroma_denoise(img, strength, self.scan.space, size=max(H, W))
        return np.asarray(img, np.float32)[y0 - py0:y1 - py0, x0 - px0:x1 - px0]

    def raw(self, size):
        return self.scan.rgb if size == "full" else self.proxies[size]

    # ------------------------------------------------------------ dust
    def dust_on(self):
        d = self.dust
        H, W = self.scan.rgb.shape[:2]
        for s in d["spots"]:
            s.setdefault("px", round(max((s["box"][2] - s["box"][0]) * W, (s["box"][3] - s["box"][1]) * H)))
        return dust.healed(d["spots"], d["threshold"], d["size"]) if d["repair"] else []

    def task(self, label, frac):
        self.progress = {"label": label, "frac": float(frac)} if frac < 1 else None

    def healed_base(self, size, ids):
        """The scan at this size with the given spots repaired. Repairs are
        computed once per spot and size, so switching one on or off is quick."""
        done = self._ensure_patches(size, ids)
        return dust.apply(self.raw(size), [p for sid in ids for p in done.get(sid, [])])

    def dust_changed(self, new_spots=False):
        if new_spots:
            self._patches, self._nr_cache = {}, {}
        side = sidecar_path(self.scan.path)
        doc = json.loads(side.read_text()) if side.exists() else {}
        doc["dust"] = self.dust
        side.write_text(json.dumps(doc, indent=1))

    def dust_view(self, params):
        """The dust state for the browser, with each spot's place in the straightened view."""
        H, W = self.scan.rgb.shape[:2]
        self.dust_on()  # fills in sizes of older spots
        on = {s["id"] for s in dust.healed(self.dust["spots"], self.dust["threshold"], self.dust["size"])}
        out = []
        for s in self.dust["spots"]:
            x0, y0, x1, y1 = s["box"]
            u, v = pipeline.geometry_point((x0 + x1) / 2, (y0 + y1) / 2, W, H, params["angle"], params["distortion"])
            r = max((x1 - x0) * W, (y1 - y0) * H) / 2 / max(W, H)
            out.append({"id": s["id"], "x": u, "y": v, "r": r, "conf": s["conf"], "kind": s.get("kind", "speck"),
                        "px": round(max((x1 - x0) * W, (y1 - y0) * H)),
                        # its exact shape: a bitmap stretched over the box (box size in view fractions)
                        "mask": s.get("mask"), "mw": s.get("mw"), "mh": s.get("mh"),
                        "bw": (x1 - x0) * W / max(W, H), "bh": (y1 - y0) * H / max(W, H),
                        "on": s.get("on"), "healed": s["id"] in on})
        return {"spots": out, "threshold": self.dust["threshold"], "repair": self.dust["repair"], "size": self.dust["size"]}

    def dust_mask(self, params):
        """A mask of the marked dust, lined up with the exported TIFF."""
        from PIL import Image
        H, W = self.scan.rgb.shape[:2]
        self.dust_on()
        m = dust.mask_image(dust.healed(self.dust["spots"], self.dust["threshold"], self.dust["size"]), H, W)
        m = pipeline.geometry(m[..., None].astype(np.float32), params["angle"], params["distortion"])
        m = pipeline.crop(m, params["crop"])[..., 0]
        path = self.scan.path.with_name(self.scan.path.stem + "_filmneg_dust.png")
        Image.fromarray(np.where(m > 127, 255, 0).astype(np.uint8)).save(path)
        return str(path)

    def render(self, params, size="preview", cropped=True, original=False, region=None):
        """region (fractions of the cropped image) renders that part from full resolution."""
        params = pipeline.normalize(params)
        # a peek (one spot shown or hidden while you review it) is pasted into the
        # zoomed-in region only; the whole-picture render ignores it, so stepping
        # through the spots never re-renders the whole scan
        peek = params.pop("dust_peek", None)
        if region:
            size = "full"
        src = self.source(size, params, nr=not original)
        if cropped:
            src = pipeline.crop(src, params["crop"])
        if region:
            src = pipeline.crop(src, region)
            if peek and not original:
                src = self._peek_region(src, params, region, peek)
            src = imageio.downsample(src, REGION)
        if original:
            return src
        return pipeline.render_pixels(src, params, self.scan.space)

    def _peek_region(self, src, params, region, peek):
        """Show or hide single spots' repairs inside a full-resolution region
        (src, a view into the cached source), worked out around those spots only."""
        H, W = self.scan.rgb.shape[:2]
        c = params["crop"]
        oy = int(round(c[1] * H)) + int(round(region[1] * (int(round(c[3] * H)) - int(round(c[1] * H)))))
        ox = int(round(c[0] * W)) + int(round(region[0] * (int(round(c[2] * W)) - int(round(c[0] * W)))))
        ids = frozenset(x["id"] for x in self.dust_on())
        show, hide = set(peek.get("show", [])), set(peek.get("hide", []))
        changed = (show - ids) | (hide & ids)
        if not changed:
            return src
        ids = (ids | show) - hide
        self._ensure_patches("full", ids)
        geo = (round(float(params["angle"]), 2), round(float(params["distortion"]), 2))
        strength = round(float(params.get("nr", 0)), 3)
        out = np.array(src, np.float32, copy=True)
        for win in self._spot_windows("full", changed, geo):
            y0, y1, x0, x1 = win
            ya, yb = max(y0, oy), min(y1, oy + out.shape[0])
            xa, xb = max(x0, ox), min(x1, ox + out.shape[1])
            if ya < yb and xa < xb:
                v = self._window("full", win, ids, strength, geo)
                out[ya - oy:yb - oy, xa - ox:xb - ox] = v[ya - y0:yb - y0, xa - x0:xb - x0]
        return out

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

    def save(self, doc):
        side = sidecar_path(self.scan.path)
        keep = {k: doc[k] for k in ("params", "samples", "versions", "history") if k in doc}
        keep["dust"] = self.dust
        side.write_text(json.dumps(keep, indent=1))
        return str(side)

    def export(self, params):
        self.task("Exporting", 0.1)
        out = self.render(params, size="full")
        self.task("Exporting", 0.9)
        path = self.scan.path.with_name(self.scan.path.stem + "_filmneg.tif")
        imageio.save_tiff16(path, out, self.scan.icc)
        self.task("", 1)
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
        if route in ("balance", "report"):
            # points marked Black / Grey / White balance the picture (in Levels); skin
            # points are only compared with skin; plain points are only read
            samples = body.get("samples", [])
            active = [x for x in samples if x.get("kind") in ("neutral", "white", "black", "skin")]
            colors = s.sample_colors(active, p)
            kinds = [x["kind"] for x in active]
            if route == "balance":
                used = [(c, k) for c, k in zip(colors, kinds) if k != "skin"]
                # always afresh from the points there are now (none: no balance)
                p = analysis.balance([c for c, _ in used], [k for _, k in used], p, s.scan.space)
            rep = iter(analysis.sample_report(colors, kinds, p, s.scan.space) if active else [])
            report = [next(rep) if x.get("kind") in ("neutral", "white", "black", "skin") else None for x in samples]
            return {"params": p, "report": report} if route == "balance" else {"report": report}
        if route == "probe":
            src = s.source("preview", p)
            out = pipeline.render_pixels(src, p, s.scan.space)
            return analysis.probe(src, out, body["at"], p, s.scan.space)
        if route == "neutralize":
            col = analysis.sample_color(s.source("preview", p), body["at"])
            return analysis.neutralize(col, body.get("kind", "neutral"), p, s.scan.space, float(body.get("sigma", 0.15)))
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
            light = curves.apply(p["curves"]["lightness"], tone)
            pack = lambda a: base64.b64encode(np.ascontiguousarray(a, "<f4").tobytes()).decode()
            return {"n": LUT_N, "table": pack(table), "shifts": pack(shifts), "light": pack(light), "space": s.space_info()}
        if route == "dust_find":
            manual = [d for d in s.dust["spots"] if d.get("manual")]
            found = dust.find(s.scan.rgb, _unrotated_box(p, s.scan.rgb.shape),
                              progress=lambda f: s.task("Finding dust", f))
            s.task("", 1)
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
            if "size" in body:  # smallest and largest spot considered, in scan pixels
                d["size"] = [max(1, int(body["size"][0])), max(2, int(body["size"][1]))]
            if body.get("id") in spots and "on" in body:
                spots[body["id"]]["on"] = body["on"]
                dust.relearn(d["spots"])  # your decisions move similar spots up or down
            if body.get("remove") in spots:
                d["spots"].remove(spots[body["remove"]])
            if "add" in body:  # a spot marked by hand, in the straightened view
                H, W = s.scan.rgb.shape[:2]
                a = body["add"]
                u, v = pipeline.geometry_point(a["x"], a["y"], W, H, p["angle"], p["distortion"], inverse=True)
                rx, ry = a["r"] * max(W, H) / W, a["r"] * max(W, H) / H
                d["spots"].append({"id": max(spots, default=0) + 1, "box": [u - rx, v - ry, u + rx, v + ry],
                                   "conf": 1.0, "kind": "manual", "manual": True, "on": True})
            if "clone" in body:  # a clone-stamp stroke, in the straightened view
                H, W = s.scan.rgb.shape[:2]
                c = body["clone"]
                raw = lambda x, y: pipeline.geometry_point(x, y, W, H, p["angle"], p["distortion"], inverse=True)
                pts = [raw(*q) for q in c["points"]]
                src = raw(*c["src"])
                d["spots"].append({"id": max(spots, default=0) + 1,
                                   **dust.clone_spot(pts, c["r"], (src[0] - pts[0][0], src[1] - pts[0][1]), W, H)})
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
            if self.path.startswith("/api/progress"):  # answered without the lock, while a task runs
                return self._send(200, json.dumps(session.progress).encode(), "application/json")
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
                        return self._send(200, imageio.to_jpeg(rgb, session.scan.space, 90), "image/jpeg")
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
                session.progress = None
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
