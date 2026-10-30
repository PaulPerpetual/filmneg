"""Measuring the image and computing small, smooth corrections."""
import numpy as np
from scipy.optimize import least_squares

from . import curves
from .color import SKIN_HUE, RGBSpace, luma
from .pipeline import crop, render_pixels, to_working_linear

# Target Oklab (a, b) for things that should be neutral, per lighting. Not
# always 0: golden hour or tungsten should stay recognisably warm.
LIGHTING = {
    "neutral": (0.0, 0.0),
    "daylight": (0.001, 0.006),
    "overcast / shade": (-0.002, -0.006),
    "golden hour": (0.006, 0.022),
    "tungsten": (0.008, 0.03),
}

# Lightness (Oklab L) that "white" and "black" samples should land on.
WHITE_L = 0.95
BLACK_L = 0.12


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
    ta, tb = LIGHTING.get(params["lighting"], (0.0, 0.0))
    out = []
    for kind, (L, a, b) in zip(kinds, lab):
        if kind == "skin":
            hue = np.arctan2(b, a)
            off = np.degrees(np.arctan2(np.sin(hue - SKIN_HUE), np.cos(hue - SKIN_HUE)))
            out.append({"L": float(L), "a": float(a), "b": float(b), "hue_off": float(off)})
        else:
            out.append({"L": float(L), "a": float(a), "b": float(b),
                        "da": float((a - ta) * 1000), "db": float((b - tb) * 1000)})
    return out


def solve(colors, kinds, params, space: RGBSpace):
    """Smallest per-channel slope/offset change that makes the samples right.

    Green is the reference; red and blue each get a slope and an offset in the
    log domain. With samples at several brightnesses this removes crossover
    (a cast that changes with tone); with one sample it reduces to a white
    balance, because the slopes are held near 1 by regularisation. White and
    black samples also pin exposure and contrast.
    """
    colors = np.asarray(colors, dtype=np.float32)
    kinds = list(kinds)
    if not len(colors):
        return params
    ta, tb = LIGHTING.get(params["lighting"], (0.0, 0.0))
    tone_kinds = {"white", "black"} & set(kinds)
    base_slope = np.array(params["slope"], float)
    base_offset = np.array(params["offset"], float)

    def unpack(x):
        p = dict(params)
        p["slope"] = [base_slope[0] + x[0], base_slope[1], base_slope[2] + x[1]]
        p["offset"] = [base_offset[0] + x[2], base_offset[1], base_offset[2] + x[3]]
        if tone_kinds:
            p["exposure"] = params["exposure"] + x[4]
            p["contrast"] = params["contrast"] * np.exp(x[5])
        return p

    skin_n = np.array([-np.sin(SKIN_HUE), np.cos(SKIN_HUE)])  # normal to the skin hue ray

    def residuals(x):
        lab = _oklab(render_pixels(colors, unpack(x), space), space)
        r = []
        for kind, (L, a, b) in zip(kinds, lab):
            if kind == "skin":
                r.append(0.5 * float(np.dot(skin_n, [a, b])))
            else:
                r += [a - ta, b - tb]
                if kind == "white":
                    r.append(0.3 * (L - WHITE_L))
                elif kind == "black":
                    r.append(0.3 * (L - BLACK_L))
        r += list(0.01 * np.asarray(x[:2]))   # keep slopes near where they were
        r += list(0.003 * np.asarray(x[2:4]))  # and offsets small
        if tone_kinds:
            r += [0.003 * x[4], 0.01 * x[5]]
        return np.array(r, dtype=np.float64)

    def jacobian(x, h=1e-3):
        # Rendering is float32, so use a fixed, visible step for the differences.
        f0 = residuals(x)
        return np.stack([(residuals(x + h * e) - f0) / h for e in np.eye(len(x))], axis=1)

    n = 6 if tone_kinds else 4
    res = least_squares(residuals, np.zeros(n), jac=jacobian)
    out = unpack(res.x)
    out["slope"] = [float(v) for v in out["slope"]]
    out["offset"] = [float(v) for v in out["offset"]]
    out["exposure"] = float(out["exposure"])
    out["contrast"] = float(out["contrast"])
    return out


def cast_by_tone(rendered, space: RGBSpace, bins=None, max_chroma=0.04, min_count=50):
    """Mean Oklab a/b of near-neutral pixels, binned by tone.

    A balanced image gives a flat line at the lighting target; crossover shows
    as a bend. Bins line up with the curve control positions.
    """
    pos = curves.ctrl_positions() if bins is None else bins
    px = rendered.reshape(-1, 3)
    lab = _oklab(px, space)
    t = luma(px)
    chroma = np.hypot(lab[:, 1], lab[:, 2])
    keep = chroma < max_chroma
    width = (pos[1] - pos[0]) if len(pos) > 1 else 1.0
    out = []
    for p in pos:
        m = keep & (np.abs(t - p) < width * 0.75)
        cnt = int(m.sum())
        if cnt >= min_count:
            out.append((float(lab[m, 1].mean()), float(lab[m, 2].mean()), cnt))
        else:
            out.append((0.0, 0.0, 0))
    return out


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


def cast_report(rendered, colors, kinds, report, params, space: RGBSpace):
    """Plain-language summary of the casts left in the image, by brightness band.

    Grey/white/black samples in a band are trusted first; bands without one
    fall back to the near-grey areas of the picture.
    """
    ta, tb = LIGHTING.get(params["lighting"], (0.0, 0.0))
    px = rendered.reshape(-1, 3)
    lab = _oklab(px, space)
    t = luma(px)
    grey = np.hypot(lab[:, 1] - ta, lab[:, 2] - tb) < 0.04
    lines, casts = [], []
    for (name, lo, hi), (llo, lhi) in zip(BANDS, BANDS_L):
        own = [(r["da"], r["db"]) for k, r in zip(kinds, report)
               if k != "skin" and llo <= r["L"] < lhi]
        if own:
            a, b = np.mean(own, axis=0)
            src = f"from {len(own)} sample{'s' if len(own) > 1 else ''}"
        else:
            m = grey & (t >= lo) & (t < hi)
            if m.sum() < 200:
                lines.append({"band": name, "text": "no grey areas to judge by", "src": ""})
                casts.append(None)
                continue
            a, b = (lab[m, 1].mean() - ta) * 1000, (lab[m, 2].mean() - tb) * 1000
            src = "from grey-ish areas in the picture"
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
            summary = ("The cast changes with brightness. Grey samples at several brightnesses and Solve samples, "
                       "or Straighten casts, fix that.")
    for i, (k, r) in enumerate(zip(kinds, report)):
        if k == "skin" and abs(r["hue_off"]) > 8:
            way = "too yellow" if r["hue_off"] > 0 else "too red/pink"
            lines.append({"band": f"Skin {i + 1}", "text": f"a bit {way} ({abs(r['hue_off']):.0f}°)", "src": "", "cast": True})
    return {"lines": lines, "summary": summary}


def straighten(rgb, params, space: RGBSpace, strength=1.0, smoothness=1.0,
                keep_overall=True, iterations=4):
    """Bend the warmth/tint curves so near-neutral areas are neutral at every tone.

    Measures the cast per tone band, converts it to curve units with a
    measured 2x2 response, then applies a smoothed, damped correction. Only
    bands with enough near-neutral pixels are trusted.

    keep_overall only removes the part of the cast that *changes* with tone
    (crossover) and leaves the image's overall colour alone. strength scales
    the correction (0..1), smoothness how gently it may bend.
    """
    p = {**params, "curves": {k: list(v) for k, v in params["curves"].items()}}
    ta, tb = LIGHTING.get(params["lighting"], (0.0, 0.0))
    n = curves.N_CTRL

    # How Oklab (a, b) of a mid grey responds to warmth and tint pushes.
    grey = np.full((1, 3), 0.5, np.float32)
    flat = {**p, "curves": {k: curves.zero_curve() for k in p["curves"]}, "saturation": 1.0}
    base = _oklab(render_pixels(grey, flat, space), space)[0, 1:]
    jac = np.zeros((2, 2))
    for j, name in enumerate(("warmth", "tint")):
        q = {**flat, "curves": {**flat["curves"], name: [0.01] * n}}
        jac[:, j] = (_oklab(render_pixels(grey, q, space), space)[0, 1:] - base) / 0.01
    inv = np.linalg.inv(jac)

    # Second-difference smoothing keeps the correction a gentle curve.
    d2 = np.diff(np.eye(n), 2, axis=0)
    smooth = np.linalg.inv(np.eye(n) + 8.0 * smoothness * d2.T @ d2)

    for _ in range(iterations):
        out = render_pixels(rgb, p, space)
        bands = cast_by_tone(out, space)
        dw, dm = np.zeros(n), np.zeros(n)
        for i, (a, b, cnt) in enumerate(bands):
            if cnt:
                dw[i], dm[i] = inv @ np.array([a - ta, b - tb])
        conf = np.array([min(c / 2000, 1.0) for *_, c in bands])
        if keep_overall and conf.sum() > 0:
            dw[conf > 0] -= np.average(dw, weights=conf)
            dm[conf > 0] -= np.average(dm, weights=conf)
        for name, d in (("warmth", dw), ("tint", dm)):
            p["curves"][name] = list(np.asarray(p["curves"][name]) - smooth @ (0.6 * strength * conf * d))
    p["curves"] = {k: [float(x) for x in v] for k, v in p["curves"].items()}
    return p


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
