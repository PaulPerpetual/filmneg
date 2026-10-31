"""Measuring the image and computing small, smooth corrections."""
import numpy as np
from scipy.optimize import least_squares

from . import curves
from .color import SKIN_HUE, RGBSpace, luma
from .pipeline import crop, pre_levels, render_pixels, to_working_linear

# What "neutral" should look like under the light the picture was taken in.
# Warmth 0 is pure grey; 1 is golden hour, a grey that stays recognisably warm.
# Tint moves it towards magenta (+) or green (-). Each brightness range can lean
# further on top, e.g. warm highlights with neutral shadows.
WARM_AB = (0.006, 0.022)   # Oklab (a, b) at warmth 1
TINT_A = 0.01              # Oklab a at tint 1
LIGHT_PRESETS = {"overcast / shade": -0.27, "neutral": 0.0, "daylight": 0.27, "golden hour": 1.0, "tungsten": 1.36}
RANGES = ("shadows", "midtones", "highlights")
RANGE_L = (0.3, 0.6, 0.88)  # Oklab L each range is centred on


def target(params, L):
    """Oklab (a, b) a grey/white/black of lightness L should land on."""
    lt = params["light"]
    w = lt["warmth"] + float(np.interp(L, RANGE_L, [lt[r][0] for r in RANGES]))
    t = lt["tint"] + float(np.interp(L, RANGE_L, [lt[r][1] for r in RANGES]))
    return WARM_AB[0] * w + TINT_A * t, WARM_AB[1] * w




def auto_crop(rgb, thresh=0.6):
    """Find the image inside scanner surround and film rebate.

    Border rows/columns are mostly near-white (no film) or near-black (clear
    film edge after inversion). Trim them from each side, then inset a bit.
    """
    border = (rgb.min(axis=-1) > 0.97) | (rgb.max(axis=-1) < 0.04)

    def span(frac):
        idx = np.where(frac < thresh)[0]
        if len(idx) == 0:
            return 0, len(frac)
        return idx[0], idx[-1] + 1

    h, w = border.shape
    y0, y1 = span(border.mean(axis=1))
    x0, x1 = span(border.mean(axis=0))
    inset = 0.02
    return [x0 / w + inset, y0 / h + inset, x1 / w - inset, y1 / h - inset]


def auto_levels(rgb, params, space: RGBSpace, lo=0.05, hi=99.9):
    """Per-channel black/white points from histogram percentiles, in linear light.

    Values the scanner already clipped (exactly 0 or 1) are ignored, so they
    don't pull the percentiles.
    """
    p = dict(params, black=[0.0] * 3, white=[1.0] * 3)
    lin = to_working_linear(crop(rgb, params["crop"]), p, space).reshape(-1, 3)
    black, white = [], []
    for c in range(3):
        v = lin[:, c]
        v = v[(v > 1e-6) & (v < np.max(v) - 1e-6)] if params["mode"] == "positive" else v
        b, w = np.percentile(v, [lo, hi])
        black.append(float(b))
        white.append(float(max(w, b + 1e-3)))
    return black, white


def sample_color(rgb, s):
    """Average encoded RGB in a circle (x, y, r as fractions); r = 0 samples one point.

    Pixels far from the median (dust, scratches) are dropped before averaging.
    """
    h, w = rgb.shape[:2]
    cx, cy = s["x"] * w - 0.5, s["y"] * h - 0.5
    r = max(s.get("r", 0) * max(h, w), 1.0)
    y0, y1 = int(max(np.floor(cy - r), 0)), int(min(np.ceil(cy + r) + 1, h))
    x0, x1 = int(max(np.floor(cx - r), 0)), int(min(np.ceil(cx + r) + 1, w))
    yy, xx = np.mgrid[y0:y1, x0:x1]
    inside = (np.hypot(xx - cx, yy - cy) <= r).ravel()
    pix = rgb[y0:y1, x0:x1].reshape(-1, 3)
    if inside.any():
        pix = pix[inside]
    med = np.median(pix, axis=0)
    mad = np.median(np.abs(pix - med), axis=0) + 1e-4
    ok = np.all(np.abs(pix - med) <= 4 * 1.4826 * mad, axis=1)
    if ok.sum() >= max(3, 0.5 * len(pix)):
        pix = pix[ok]
    return pix.mean(axis=0)


def _oklab(enc, space):
    return space.lin_to_oklab(space.decode(enc))


def sample_report(colors, kinds, params, space: RGBSpace):
    """How far each sample is from its target after rendering, in 1/1000 Oklab units."""
    lab = _oklab(render_pixels(np.asarray(colors), params, space), space)
    out = []
    for kind, (L, a, b) in zip(kinds, lab):
        ta, tb = target(params, L)
        if kind == "skin":
            hue = np.arctan2(b, a)
            off = np.degrees(np.arctan2(np.sin(hue - SKIN_HUE), np.cos(hue - SKIN_HUE)))
            out.append({"L": float(L), "a": float(a), "b": float(b), "hue_off": float(off)})
        else:
            out.append({"L": float(L), "a": float(a), "b": float(b),
                        "da": float((a - ta) * 1000), "db": float((b - tb) * 1000)})
    return out


def solve(colors, kinds, params, space: RGBSpace):
    """Make the samples right with as small and smooth a change as possible.

    Only Levels and the Colour by tone curves are changed, so everything Solve
    does can be seen and readjusted by hand; the base (exposure, contrast, ...)
    is left alone. White and black samples work like the eyedroppers of a
    classic Levels: they set the R, G and B input white / black points so the
    sample becomes neutral white / black. Grey and skin samples then bend the
    warmth and tint curves at their brightness (see _solve_curves); with greys
    at several brightnesses that removes crossover, a cast that changes with tone.
    """
    colors = np.asarray(colors, dtype=np.float32)
    kinds = list(kinds)
    if not len(colors):
        return params
    out = eyedrop(colors, kinds, params, space)
    if any(k not in ("white", "black") for k in kinds):
        out = _solve_curves(colors, kinds, out, space)
    return out


def eyedrop(colors, kinds, params, space: RGBSpace):
    """White / black samples -> each channel's input white / black point in Levels."""
    pre = pre_levels(np.asarray(colors, np.float32), params, space)
    levels = {ch: dict(v) for ch, v in params["levels"].items()}
    for kind, key in (("white", "hi"), ("black", "lo")):
        sel = [pre[i] for i, k in enumerate(kinds) if k == kind]
        if not sel:
            continue
        v = np.mean(sel, axis=0)
        for i, ch in enumerate("rgb"):
            L = levels[ch]
            # a white sample darker than the black point (or the reverse) can't flatten the picture
            if key == "hi":
                L["hi"] = float(np.clip(v[i], L["lo"] + 0.05, 1.0))
            else:
                L["lo"] = float(np.clip(v[i], 0.0, L["hi"] - 0.05))
    return {**params, "levels": levels}


def _grey_residuals(colors, kinds, p, params, space, reg):
    skin_n = np.array([-np.sin(SKIN_HUE), np.cos(SKIN_HUE)])  # normal to the skin hue ray
    lab = _oklab(render_pixels(colors, p, space), space)
    r = []
    for kind, (L, a, b) in zip(kinds, lab):
        if kind == "skin":
            r.append(0.5 * float(np.dot(skin_n, [a, b])))
        else:
            ta, tb = target(params, L)
            r += [a - ta, b - tb]
    return np.array(r + list(reg), dtype=np.float64)


def _jac(f, x, h=1e-3):
    # Rendering is float32, so use a fixed, visible step for the differences.
    f0 = f(x)
    return np.stack([(f(x + h * e) - f0) / h for e in np.eye(len(x))], axis=1)


def _solve_curves(colors, kinds, params, space: RGBSpace):
    """Smallest smooth change of the warmth and tint curves that makes the samples
    neutral (or the light's target; skin: on the skin hue line). White and black
    samples count as greys, so the ends stay neutral too."""
    c0 = {n: np.asarray(params["curves"][n], float) for n in ("warmth", "tint")}
    n = len(c0["warmth"])
    grey_kinds = ["neutral" if k in ("white", "black") else k for k in kinds]

    def unpack(x):
        cv = dict(params["curves"])
        cv["warmth"] = [float(v) for v in c0["warmth"] + x[:n]]
        cv["tint"] = [float(v) for v in c0["tint"] + x[n:]]
        return {**params, "curves": cv}

    def residuals(x):
        d = [x[:n], x[n:]]
        # small and smooth: the change spreads gently between the samples' tones
        reg = np.concatenate([0.005 * v for v in d] + [0.3 * np.diff(v, 2) for v in d])
        return _grey_residuals(colors, grey_kinds, unpack(x), params, space, reg)

    res = least_squares(residuals, np.zeros(2 * n), jac=lambda x: _jac(residuals, x))
    return unpack(res.x)


BANDS = (("Shadows", 0.0, 0.33), ("Midtones", 0.33, 0.66), ("Highlights", 0.66, 1.01))  # encoded luma
BANDS_L = ((0.0, 0.45), (0.45, 0.74), (0.74, 1.01))  # the same bands in Oklab L, for samples


def _cast_words(a, b):
    """A cast (Oklab a/b, in 1/1000) in words, or None if it is too small to see."""
    c = np.hypot(a, b)
    if c < 4:
        return None
    hue = np.degrees(np.arctan2(b, a)) % 360
    names = ["magenta-red", "orange", "yellow", "yellow-green", "green", "cyan", "blue", "purple"]
    name = names[int(((hue + 22.5) % 360) // 45)]
    size = "slightly" if c < 10 else "noticeably" if c < 20 else "strongly"
    return f"{size} {name}"


def band_casts(rendered, kinds, report, params, space: RGBSpace):
    """Per brightness band: ((a, b) cast in 1/1000 Oklab from its target, source) or None.

    Grey/white/black samples in a band are trusted first; bands without one
    fall back to the near-grey areas of the picture.
    """
    px = rendered.reshape(-1, 3)
    lab = _oklab(px, space)
    t = luma(px)
    out = []
    for (name, lo, hi), (llo, lhi) in zip(BANDS, BANDS_L):
        own = [(r["da"], r["db"]) for k, r in zip(kinds, report)
               if k != "skin" and llo <= r["L"] < lhi]
        if own:
            out.append((tuple(np.mean(own, axis=0)), f"from {len(own)} sample{'s' if len(own) > 1 else ''}"))
            continue
        ta, tb = target(params, (llo + min(lhi, 1.0)) / 2)
        m = (np.hypot(lab[:, 1] - ta, lab[:, 2] - tb) < 0.04) & (t >= lo) & (t < hi)
        if m.sum() < 200:
            out.append(None)
            continue
        out.append((((lab[m, 1].mean() - ta) * 1000, (lab[m, 2].mean() - tb) * 1000),
                    "from grey-ish areas in the picture"))
    return out


def cast_report(rendered, colors, kinds, report, params, space: RGBSpace):
    """Plain-language summary of the casts left in the image, by brightness band."""
    lines, casts = [], []
    for (name, _, _), c in zip(BANDS, band_casts(rendered, kinds, report, params, space)):
        if c is None:
            lines.append({"band": name, "text": "no grey areas to judge by", "src": ""})
            casts.append(None)
            continue
        (a, b), src = c
        words = _cast_words(a, b)
        casts.append((a, b))
        lines.append({"band": name, "text": words or "neutral", "src": src, "cast": bool(words)})
    known = [c for c in casts if c is not None]
    if not known:
        summary = "Not enough grey areas to judge. Add Grey samples."
    elif not any(l.get("cast") for l in lines):
        summary = "Greys look neutral in all tones."
    else:
        spread = max(np.hypot(x[0] - y[0], x[1] - y[1]) for x in known for y in known)
        if spread < 6:
            summary = "The same cast in all tones: one Grey sample and Solve samples (a white balance) fixes it."
        else:
            summary = ("The cast changes with brightness: add Grey samples at several brightnesses "
                       "and Solve samples.")
    for i, (k, r) in enumerate(zip(kinds, report)):
        if k == "skin" and abs(r["hue_off"]) > 8:
            way = "too yellow" if r["hue_off"] > 0 else "too red/pink"
            lines.append({"band": f"Skin {i + 1}", "text": f"a bit {way} ({abs(r['hue_off']):.0f}°)", "src": "", "cast": True})
    return {"lines": lines, "summary": summary}


def probe(rgb, rendered, s, params, space: RGBSpace):
    """What a small area looks like before and after, and where it sits on the curves."""
    src = sample_color(rgb, s)
    out = sample_color(rendered, s)
    L, a, b = _oklab(out, space)
    hue = np.arctan2(b, a)
    return {
        "input": [float(v) for v in src],
        "output": [float(v) for v in out],
        "tone": float(luma(out)),
        "L": float(L), "a": float(a), "b": float(b),
        "chroma": float(np.hypot(a, b)),
        "skin_hue_off": float(np.degrees(np.arctan2(np.sin(hue - SKIN_HUE), np.cos(hue - SKIN_HUE)))),
    }
