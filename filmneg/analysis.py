"""Measuring the image and computing small, smooth corrections."""
import numpy as np
from scipy.optimize import least_squares

from . import curves
from .color import SKIN_HUE, RGBSpace, luma
from .pipeline import crop, curve_tone, pre_levels, render_pixels, to_working_linear

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


def balance(colors, kinds, params, space: RGBSpace):
    """Neutral balance from black / grey / white samples, the way the eyedroppers
    of Photoshop's Levels or DaVinci's lift / gamma / gain work, all in Levels:

    - black and white samples set each channel's input black / white point so the
      sample lands neutral at the black / white target (10 and 245 by default,
      not 0 and 255, so they keep a little density and look natural);
    - greys set each channel's grey (gamma) slider so they come out neutral at
      the brightness they have;
    - only greys at several brightnesses (a cast that changes with tone, film
      crossover) or a light that isn't neutral also move the Colour by tone
      curves' three handles, for what Levels can't do.
    """
    colors = np.asarray(colors, np.float32)
    kinds = list(kinds)
    if not len(colors):
        return params
    greys = [c for c, k in zip(colors, kinds) if k == "neutral"]
    out = params
    # the end points and the grey slider depend on each other: settle them together
    for _ in range(6 if greys else 1):
        out = eyedrop(colors, kinds, out, space)
        if greys:
            out = grey_gamma(greys, out, space)
    lt = params["light"]
    tinted = abs(lt["warmth"]) + abs(lt["tint"]) + sum(abs(v) for r in RANGES for v in lt[r]) > 1e-6
    tones = luma(render_pixels(np.asarray(greys, np.float32), out, space)) if greys else []
    if tinted or (len(tones) and np.ptp(tones) > 0.12):
        out = _solve_curves(colors, kinds, out, space)
    return out


def grey_gamma(colors, params, space: RGBSpace):
    """Each channel's grey slider in Levels so these greys come out neutral at
    their own brightness (one grey: exactly; several: the best fit)."""
    pre = pre_levels(np.asarray(colors, np.float32), params, space)
    levels = {ch: dict(v) for ch, v in params["levels"].items()}
    y = np.stack([np.clip((pre[:, i] - levels[ch]["lo"]) / max(levels[ch]["hi"] - levels[ch]["lo"], 1e-3), 1e-3, 1 - 1e-3)
                  for i, ch in enumerate("rgb")], axis=1)
    m = np.clip(y @ np.array([0.2126, 0.7152, 0.0722]), 1e-3, 1 - 1e-3)
    for i, ch in enumerate("rgb"):
        ly, lm = np.log(y[:, i]), np.log(m)
        k = float(np.sum(ly * lm) / max(np.sum(ly * ly), 1e-9))  # y ** k = m, least squares in log
        levels[ch]["gamma"] = float(np.clip(1.0 / max(k, 1e-3), 0.2, 5.0))
    return {**params, "levels": levels}


def eyedrop(colors, kinds, params, space: RGBSpace):
    """White / black samples -> each channel's input white / black point in Levels,
    so the sample lands neutral at the white / black target (params["targets"])."""
    pre = pre_levels(np.asarray(colors, np.float32), params, space)
    levels = {ch: dict(v) for ch, v in params["levels"].items()}
    tg = params.get("targets", {"black": 10, "white": 245})
    pick = lambda kind: np.mean([pre[i] for i, k in enumerate(kinds) if k == kind], axis=0) if kind in kinds else None
    vw, vb = pick("white"), pick("black")
    for i, ch in enumerate("rgb"):
        L = levels[ch]
        g = L["gamma"]  # the target is reached after the channel's grey slider
        tb, tw = (tg["black"] / 255) ** g, (tg["white"] / 255) ** g
        if vw is not None and vb is not None and vw[i] - vb[i] > 0.02:
            span = (vw[i] - vb[i]) / (tw - tb)
            lo = vb[i] - tb * span
            L["lo"], L["hi"] = float(lo), float(lo + span)
        elif vw is not None:
            L["hi"] = float(L["lo"] + max(vw[i] - L["lo"], 0.05) / tw)
        elif vb is not None:
            L["lo"] = float(min((vb[i] - tb * L["hi"]) / (1 - tb), L["hi"] - 0.05))
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


UNIT = 0.01


def neutralize(color, kind, params, space: RGBSpace, sigma=0.15):
    """Warmth / tint curve changes, as a soft bump around this colour's own
    brightness, that correct it, returned as control-point deltas so they can be
    dialled in partly. "b" takes the yellow/blue cast away and leaves
    magenta/green as it is, "a" the other way round; "full" does both (to grey,
    or the light's target; for skin: onto the skin hue line)."""
    color = np.asarray([color], np.float32)
    tone = float(curve_tone(color, params, space)[0])  # where the colour curves see it
    L0, a0, b0 = _oklab(render_pixels(color, params, space), space)[0]
    ta, tb = target(params, L0)

    def unpack(x):
        cv = dict(params["curves"])
        for i, n in enumerate(("warmth", "tint")):
            cv[n] = list(np.asarray(cv[n], float) + curves.bump(tone, x[i], sigma))
        return {**params, "curves": cv}

    def axis(want_a, want_b):
        def f(x):
            _, a, b = _oklab(render_pixels(color, unpack(x), space), space)[0]
            return np.array([a - want_a, b - want_b, *(0.001 * x)])
        return f

    hue = np.arctan2(b0, a0)
    out = {"tone": tone, "cast": {"warmth": float(b0 - tb), "tint": float(a0 - ta),
                                  "skin": float(np.degrees(np.arctan2(np.sin(hue - SKIN_HUE), np.cos(hue - SKIN_HUE))))}}
    fits = {"full": lambda x: _grey_residuals(color, [kind], unpack(x), params, space, 0.001 * x)}
    if kind != "skin":
        fits.update(b=axis(a0, tb), a=axis(ta, b0))
        # one unit (0.01) more yellow, or more magenta, with the other kept: lets a
        # slider put the cast anywhere, linearly, also when it is already small
        fits.update(unit_b=axis(a0, b0 + UNIT), unit_a=axis(a0 + UNIT, b0))
    for name, f in fits.items():
        x = least_squares(f, np.zeros(2), jac=lambda x, f=f: _jac(f, x)).x
        out[name] = {n: [float(v) for v in curves.bump(tone, x[i], sigma)] for i, n in enumerate(("warmth", "tint"))}
    return out


# Ansel Adams' zones: where things typically sit, from black to paper white.
# Zone n is drawn at brightness n/10 on the curves.
ZONES = [
    "0 · pure black, no detail (film rebate)",
    "I · near black, slight tone but no texture",
    "II · first hint of texture in deep shadows",
    "III · dark materials with full texture: dark fabric, shadows with detail",
    "IV · dark foliage, dark stone, open shade in a landscape, dark skin",
    "V · middle grey: grey card, grass, weathered wood, darker skin, clear north sky",
    "VI · average light skin in sun, light stone, shadows on snow",
    "VII · very light skin, light grey objects, sidelit snow",
    "VIII · whites with texture: textured snow, white shirt, light walls",
    "IX · white without texture, glaring snow",
    "X · paper white, specular highlights, light sources",
]


HANDLES = (0.25, 0.5, 0.75)  # shadows, midtones, highlights


def three_handles(flat_ends):
    """The only shapes the fits may use: three soft handles at shadows, mids and
    highlights, like a curve with three points. Each is a tent reaching to its
    neighbours (the B-spline rounds it off). flat_ends: the outer two keep their
    value out to black / white (colour); otherwise they fade to 0 there, so the
    black and white ends stay put."""
    pos = curves.ctrl_positions(curves.N_CTRL)
    basis = np.stack([np.clip(1 - np.abs(pos - c) / 0.25, 0, 1) for c in HANDLES])
    if flat_ends:
        basis[0, pos <= HANDLES[0]] = 1.0
        basis[-1, pos >= HANDLES[-1]] = 1.0
    return basis


def _solve_curves(colors, kinds, params, space: RGBSpace):
    """Smallest change of the warmth and tint curves, using only their three
    handles (shadows, mids, highlights, like a three-way colour balance), that
    makes the samples neutral (or the light's target; skin: on the skin hue line).
    White and black samples count as greys, so the ends stay neutral too. With so
    few handles the curves stay simple and can't chase single samples."""
    c0 = {n: np.asarray(params["curves"][n], float) for n in ("warmth", "tint")}
    basis = three_handles(flat_ends=True)
    k = len(HANDLES)
    grey_kinds = ["neutral" if q in ("white", "black") else q for q in kinds]

    def unpack(x):
        cv = dict(params["curves"])
        cv["warmth"] = [float(v) for v in c0["warmth"] + x[:k] @ basis]
        cv["tint"] = [float(v) for v in c0["tint"] + x[k:] @ basis]
        return {**params, "curves": cv}

    def residuals(x):
        # the handles prefer to move together: one sample is a plain white balance,
        # and only samples at other brightnesses make the cast differ by tone
        reg = np.concatenate([0.002 * x, 0.03 * np.diff(x[:k]), 0.03 * np.diff(x[k:])])
        return _grey_residuals(colors, grey_kinds, unpack(x), params, space, reg)

    res = least_squares(residuals, np.zeros(2 * k), jac=lambda x: _jac(residuals, x))
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
            summary = "The same cast in all tones: one Grey sample and Solve (a white balance) fixes it."
        else:
            summary = ("The cast changes with brightness: add Grey samples at several brightnesses "
                       "and Solve.")
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
        "ctone": float(curve_tone(src, params, space)),  # where it sits on the Light / Colour by tone curves
        "L": float(L), "a": float(a), "b": float(b),
        "target": [float(v) for v in target(params, float(L))],  # where neutral is (the light's)
        "chroma": float(np.hypot(a, b)),
        "skin_hue_off": float(np.degrees(np.arctan2(np.sin(hue - SKIN_HUE), np.cos(hue - SKIN_HUE)))),
    }
