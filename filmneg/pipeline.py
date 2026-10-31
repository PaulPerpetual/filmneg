"""The non-destructive render pipeline.

The scan is never modified. All edits live in a JSON-friendly params dict and
the image is rendered from the original every time:

    input (encoded) -> linear light
      -> [negative mode: divide by film base, invert]
      -> per-channel levels (black/white points, linear)
      -> log2 domain: per-channel slope + offset (fixes casts that change
         with brightness, i.e. crossover), contrast, exposure
      -> soft highlight shoulder -> encode
      -> levels, classic: input black/grey/white and output black/white,
         per channel and then for all three together
      -> curves (per-channel; lightness on brightness only; warmth/tint as a function of tone)
      -> saturation (Oklab)

Chroma noise reduction is spatial, so it is applied to the input once and
cached by the session rather than being part of render_pixels().
"""
import copy

import numpy as np
from scipy.ndimage import uniform_filter

from . import curves
from .color import RGBSpace, luma

PIVOT = np.log2(0.18)  # middle grey: slope and contrast rotate around it
_EPS = 1e-5

LEVEL_CHANNELS = ("rgb", "r", "g", "b")
IDENTITY_LEVEL = {"lo": 0.0, "gamma": 1.0, "hi": 1.0, "out_lo": 0.0, "out_hi": 1.0}

DEFAULTS = {
    "mode": "positive",            # "positive" (scanner already inverted) or "negative"
    "base": None,                  # film base, linear RGB, negative mode only
    "crop": [0.0, 0.0, 1.0, 1.0],  # x0, y0, x1, y1 as fractions of the (rotated) scan
    "angle": 0.0,                  # straighten: degrees, counter-clockwise, applied before the crop
    "distortion": 0.0,             # lens: + removes barrel, - pincushion
    "black": [0.0, 0.0, 0.0],      # linear levels per channel
    "white": [1.0, 1.0, 1.0],
    "slope": [1.0, 1.0, 1.0],      # per-channel contrast in log2 domain
    "offset": [0.0, 0.0, 0.0],     # per-channel shift in stops
    "exposure": 0.0,               # stops
    "contrast": 1.0,
    "shoulder": 0.5,               # highlight roll-off, 0..1
    "toe": 0.0,                    # shadow roll-off, 0..1
    "saturation": 1.0,
    "levels": {ch: {"lo": 0.0, "gamma": 1.0, "hi": 1.0, "out_lo": 0.0, "out_hi": 1.0}
               for ch in LEVEL_CHANNELS},  # encoded values, like Pixelmator's Levels
    "nr": 0.0,                     # chroma noise reduction strength 0..1
    "targets": {"black": 10, "white": 245},  # where Balance puts black / white samples (0..255)
    # Balance: its own per-channel black / grey / white step before Levels, worked
    # out from the points (analysis.balance); strength dials each part in
    "balance": {"r": {"lo": 0.0, "gamma": 1.0, "hi": 1.0}, "g": {"lo": 0.0, "gamma": 1.0, "hi": 1.0},
                "b": {"lo": 0.0, "gamma": 1.0, "hi": 1.0},
                "strength": {"black": 1.0, "grey": 1.0, "white": 1.0}},
    "light": {"warmth": 0.0, "tint": 0.0,  # what greys should look like (see analysis.target)
              "shadows": [0.0, 0.0], "midtones": [0.0, 0.0], "highlights": [0.0, 0.0]},
    "curves": {name: curves.zero_curve() for name in curves.CURVE_NAMES},
}


def default_params():
    return copy.deepcopy(DEFAULTS)


def normalize(params):
    """Fill in anything missing so older sidecars keep working."""
    out = default_params()
    for k, v in (params or {}).items():
        if k == "curves":
            out["curves"].update(v)
        elif k == "levels":
            out["levels"] = _normalize_levels(v)
        elif k == "light":
            out["light"].update(v)
        elif k == "targets":
            out["targets"].update(v)
        elif k == "balance":
            for ch in ("r", "g", "b", "strength"):
                out["balance"][ch].update(v.get(ch, {}))
            if "key" in v:  # which points it was worked out from (the UI's "changed since" hint)
                out["balance"]["key"] = v["key"]
        elif k == "lighting":  # older sidecars: a named light
            out["light"]["warmth"] = {"overcast / shade": -0.27, "daylight": 0.27, "golden hour": 1.0,
                                      "tungsten": 1.36}.get(v, 0.0)
        else:
            out[k] = v
    return out


def _normalize_levels(v):
    levels = {ch: dict(IDENTITY_LEVEL) for ch in LEVEL_CHANNELS}
    if "lo" in v and isinstance(v["lo"], list):  # older sidecars: per-channel black/white lists
        for i, ch in enumerate("rgb"):
            levels[ch].update(lo=v["lo"][i], hi=v["hi"][i])
        return levels
    for ch in LEVEL_CHANNELS:
        levels[ch].update(v.get(ch, {}))
    return levels


def apply_level(x, L):
    """Classic levels: input black/white, a gamma (the grey slider), output black/white."""
    y = np.clip((x - L["lo"]) / max(L["hi"] - L["lo"], 1e-3), 0.0, 1.0)
    if L["gamma"] != 1.0:
        y = y ** (1.0 / L["gamma"])
    return L["out_lo"] + y * (L["out_hi"] - L["out_lo"])


def _shoulder(lin, amount=0.5):
    """Identity below the knee, then rolls highlights off smoothly towards 1.

    amount 0..1: how early and gently highlights roll off (knee 0.95 .. 0.65).
    """
    knee = 0.95 - 0.3 * amount
    span = 1.0 - knee
    rolled = knee + span * (1.0 - np.exp(-(lin - knee) / span))
    return np.where(lin > knee, rolled, lin)


def _toe(lin, amount=0.0):
    """Soft roll-off into black: deep shadows ease towards 0, mids barely move."""
    if amount <= 0:
        return lin
    c2 = (0.03 * amount) ** 2
    x = np.maximum(lin, 0.0)
    return x * x * x / (x * x + c2)


def to_working_linear(enc, params, space: RGBSpace):
    lin = space.decode(enc)
    if params["mode"] == "negative":
        base = np.asarray(params["base"] if params["base"] else [1.0, 1.0, 1.0], dtype=lin.dtype)
        lin = (base / np.maximum(lin, _EPS)) * 0.01
    black = np.asarray(params["black"], dtype=lin.dtype)
    white = np.asarray(params["white"], dtype=lin.dtype)
    return (lin - black) / np.maximum(white - black, _EPS)


def balance_levels(params):
    """Balance's effective per-channel black / grey / white, its strengths applied."""
    B = params["balance"]
    s = B["strength"]
    out = {}
    for ch in "rgb":
        L = B[ch]
        out[ch] = {"lo": s["black"] * L["lo"], "hi": 1.0 + s["white"] * (L["hi"] - 1.0),
                   "gamma": float(L["gamma"] ** s["grey"]), "out_lo": 0.0, "out_hi": 1.0}
    return out


def pre_levels(enc, params, space: RGBSpace):
    """The image as the Levels panel sees it: after the base stages and Balance."""
    out = pre_balance(enc, params, space)
    for i, L in enumerate(balance_levels(params).values()):
        if (L["lo"], L["gamma"], L["hi"]) != (0.0, 1.0, 1.0):
            out[..., i] = apply_level(out[..., i], L)
    return out


def pre_balance(enc, params, space: RGBSpace):
    """The image as Balance sees it: after the base stages."""
    lin = np.maximum(to_working_linear(enc, params, space), _EPS)
    log = np.log2(lin)
    slope = np.asarray(params["slope"], dtype=np.float32)
    offset = np.asarray(params["offset"], dtype=np.float32)
    log = slope * (log - PIVOT) + PIVOT + offset
    log = params["contrast"] * (log - PIVOT) + PIVOT + params["exposure"]
    lin = _toe(np.exp2(log), params["toe"])
    return space.encode(_shoulder(lin, params["shoulder"])).astype(np.float32)


def channel_stages(enc, params, space: RGBSpace):
    """Every stage that treats R, G and B independently, on (..., 3) arrays."""
    out = pre_levels(enc, params, space)
    lv = params["levels"]
    for i, ch in enumerate("rgb"):
        out[..., i] = apply_level(apply_level(out[..., i], lv[ch]), lv["rgb"])
    c = params["curves"]
    for i, ch in enumerate("rgb"):
        x = out[..., i]
        out[..., i] = x + curves.apply(c[ch], x)
    return out


_LUT_N = 65536  # one entry per 16-bit input value


def render_pixels(enc, params, space: RGBSpace):
    """Apply every per-pixel stage to encoded RGB values shaped (..., 3).

    The per-channel stages are baked into a 16-bit lookup table per channel
    (exact for 16-bit scans), which keeps the preview fast enough to drag.
    """
    enc = np.asarray(enc, dtype=np.float32)
    if enc.size >= 3 * 4 * _LUT_N:
        ramp = np.repeat(np.linspace(0, 1, _LUT_N, dtype=np.float32)[:, None], 3, axis=1)
        table = channel_stages(ramp, params, space)
        idx = np.clip(np.rint(enc * (_LUT_N - 1)), 0, _LUT_N - 1).astype(np.int32)
        out = np.stack([table[idx[..., i], i] for i in range(3)], axis=-1)
    else:
        out = channel_stages(enc, params, space)

    c = params["curves"]
    # Both the Light and the Colour by tone curves read the tone here, after levels
    # and the R/G/B curves ("curve tone"). So bending the Light curve never moves a
    # pixel onto another part of the colour curves: it changes brightness only. It
    # adds the same amount to R, G and B, so colours keep their hue and their
    # difference from grey.
    t = np.clip(luma(out), 0.0, 1.0).astype(np.float32)
    out += curves.apply(c["lightness"], t)[..., None]
    y0 = luma(out)
    w = curves.apply(c["warmth"], t)   # + yellow / - blue
    m = curves.apply(c["tint"], t)     # + magenta / - green
    out[..., 0] += w / 2 + m / 3
    out[..., 1] += -2 * m / 3
    out[..., 2] += -w / 2 + m / 3
    out += (y0 - luma(out))[..., None]  # colour only: brightness stays where it was

    if params["saturation"] != 1.0:
        lab = space.lin_to_oklab(space.decode(np.clip(out, 0, 1)))
        lab[..., 1:] *= params["saturation"]
        out = space.encode(np.clip(space.oklab_to_lin(lab), 0, None)).astype(np.float32)

    return np.clip(out, 0.0, 1.0)


def curve_tone(enc, params, space: RGBSpace):
    """The tone the Light and Colour by tone curves see for these colours: their
    brightness after levels and the R/G/B curves, before those two curves."""
    return np.clip(luma(channel_stages(np.asarray(enc, np.float32), params, space)), 0.0, 1.0)


def geometry(img, angle=0.0, distortion=0.0):
    """Rotate about the centre and correct radial lens distortion, keeping the size.

    angle: degrees, counter-clockwise. distortion: + removes barrel (lines that
    bow outwards), - removes pincushion; about the edge displacement in percent
    of the half-diagonal. The uncovered corners are black.
    """
    if not angle and not distortion:
        return img
    from scipy.ndimage import map_coordinates
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    sy, sx = geometry_coords(yy, xx, h, w, angle, distortion)
    out = np.empty_like(img, dtype=np.float32)
    for c in range(img.shape[2]):
        out[..., c] = map_coordinates(img[..., c], [sy, sx], order=1, mode="constant", cval=0.0)
    return out


def geometry_coords(yy, xx, h, w, angle=0.0, distortion=0.0):
    """The scan pixel (sy, sx) that geometry() samples for output pixels (yy, xx)
    of an h x w image. Also used to render a small window of the output."""
    cy, cx, R = (h - 1) / 2, (w - 1) / 2, np.hypot(h, w) / 2
    x, y = (xx - cx) / R, (yy - cy) / R
    # undistort: barrel squeezed the edges inwards, so sample further in (and out for pincushion)
    k = -0.01 * distortion
    scale = 1 + k * (x * x + y * y)
    x, y = x * scale, y * scale
    # rotate the sampling grid the other way; screen y points down
    a = np.radians(angle)
    return cy + R * (np.sin(a) * x + np.cos(a) * y), cx + R * (np.cos(a) * x - np.sin(a) * y)


def geometry_point(u, v, w, h, angle=0.0, distortion=0.0, inverse=False):
    """Map a point (fractions) through geometry(): where a scan point ends up in
    the output, or with inverse=True, which scan point an output point shows."""
    cy, cx, R = (h - 1) / 2, (w - 1) / 2, np.hypot(h, w) / 2
    k, a = -0.01 * distortion, np.radians(angle)
    x, y = (u * w - 0.5 - cx) / R, (v * h - 0.5 - cy) / R
    if inverse:  # output -> scan: exactly the sampling map of geometry()
        s = 1 + k * (x * x + y * y)
        x, y = x * s, y * s
        x, y = np.cos(a) * x - np.sin(a) * y, np.sin(a) * x + np.cos(a) * y
    else:        # scan -> output: undo the rotation, then solve the radial scale
        X, Y = np.cos(a) * x + np.sin(a) * y, -np.sin(a) * x + np.cos(a) * y
        x, y = X, Y
        for _ in range(8):
            s = 1 + k * (x * x + y * y)
            x, y = X / s, Y / s
    return (cx + R * x + 0.5) / w, (cy + R * y + 0.5) / h


def rotate(img, angle):
    return geometry(img, angle)


def crop(img, box):
    h, w = img.shape[:2]
    x0, y0, x1, y1 = box
    return img[int(round(y0 * h)):int(round(y1 * h)) or h, int(round(x0 * w)):int(round(x1 * w)) or w]


def _guided(guide, src, radius, eps):
    """He et al. guided filter: smooths src but keeps edges present in guide."""
    size = 2 * radius + 1
    mean_i = uniform_filter(guide, size)
    mean_p = uniform_filter(src, size)
    cov = uniform_filter(guide * src, size) - mean_i * mean_p
    var = uniform_filter(guide * guide, size) - mean_i * mean_i
    a = cov / (var + eps)
    b = mean_p - a * mean_i
    return uniform_filter(a, size) * guide + uniform_filter(b, size)


def nr_radius(strength, size):
    """Chroma noise radius in pixels for an image whose longer side is size."""
    return max(1, int(round(strength * size / 600)))


def chroma_denoise(enc, strength, space: RGBSpace, size=None):
    """Blur only the colour (Oklab a/b), keep lightness and its detail.

    The radius scales with image size, so a preview and the full-resolution
    export look the same. Edges come from the lightness channel, so colour
    does not bleed across them. size: the longer side of the whole image, when
    enc is only a window of it.
    """
    if strength <= 0:
        return enc
    lab = space.lin_to_oklab(space.decode(enc)).astype(np.float32)
    radius = nr_radius(strength, size or max(enc.shape[:2]))
    L = lab[..., 0]
    for i in (1, 2):
        lab[..., i] = _guided(L, lab[..., i], radius, 1e-3)
    return space.encode(np.clip(space.oklab_to_lin(lab), 0, None)).astype(np.float32)
