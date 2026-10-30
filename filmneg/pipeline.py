"""The non-destructive render pipeline.

The scan is never modified. All edits live in a JSON-friendly params dict and
the image is rendered from the original every time:

    input (encoded) -> linear light
      -> [negative mode: divide by film base, invert]
      -> per-channel levels (black/white points, linear)
      -> log2 domain: per-channel slope + offset (fixes casts that change
         with brightness, i.e. crossover), contrast, exposure
      -> soft highlight shoulder -> encode
      -> curves (lightness, per-channel, warmth/tint as a function of tone)
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
_KNEE = 0.8

DEFAULTS = {
    "mode": "positive",            # "positive" (scanner already inverted) or "negative"
    "base": None,                  # film base, linear RGB, negative mode only
    "crop": [0.0, 0.0, 1.0, 1.0],  # x0, y0, x1, y1 as fractions of the scan
    "black": [0.0, 0.0, 0.0],      # linear levels per channel
    "white": [1.0, 1.0, 1.0],
    "slope": [1.0, 1.0, 1.0],      # per-channel contrast in log2 domain
    "offset": [0.0, 0.0, 0.0],     # per-channel shift in stops
    "exposure": 0.0,               # stops
    "contrast": 1.0,
    "saturation": 1.0,
    "nr": 0.0,                     # chroma noise reduction strength 0..1
    "lighting": "neutral",
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
        else:
            out[k] = v
    return out


def _shoulder(lin):
    """Identity below the knee, then rolls highlights off smoothly towards 1."""
    span = 1.0 - _KNEE
    rolled = _KNEE + span * (1.0 - np.exp(-(lin - _KNEE) / span))
    return np.where(lin > _KNEE, rolled, lin)


def to_working_linear(enc, params, space: RGBSpace):
    lin = space.decode(enc)
    if params["mode"] == "negative":
        base = np.asarray(params["base"] if params["base"] else [1.0, 1.0, 1.0], dtype=lin.dtype)
        lin = (base / np.maximum(lin, _EPS)) * 0.01
    black = np.asarray(params["black"], dtype=lin.dtype)
    white = np.asarray(params["white"], dtype=lin.dtype)
    return (lin - black) / np.maximum(white - black, _EPS)


def _channel_stages(enc, params, space: RGBSpace):
    """Every stage that treats R, G and B independently, on (..., 3) arrays."""
    lin = np.maximum(to_working_linear(enc, params, space), _EPS)
    log = np.log2(lin)
    slope = np.asarray(params["slope"], dtype=np.float32)
    offset = np.asarray(params["offset"], dtype=np.float32)
    log = slope * (log - PIVOT) + PIVOT + offset
    log = params["contrast"] * (log - PIVOT) + PIVOT + params["exposure"]
    out = space.encode(_shoulder(np.exp2(log))).astype(np.float32)
    c = params["curves"]
    for i, ch in enumerate("rgb"):
        x = out[..., i]
        out[..., i] = x + curves.apply(c["lightness"], x) + curves.apply(c[ch], x)
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
        table = _channel_stages(ramp, params, space)
        idx = np.clip(np.rint(enc * (_LUT_N - 1)), 0, _LUT_N - 1).astype(np.int32)
        out = np.stack([table[idx[..., i], i] for i in range(3)], axis=-1)
    else:
        out = _channel_stages(enc, params, space)

    c = params["curves"]
    t = np.clip(luma(out), 0.0, 1.0).astype(np.float32)
    w = curves.apply(c["warmth"], t)   # + yellow / - blue
    m = curves.apply(c["tint"], t)     # + magenta / - green
    out[..., 0] += w / 2 + m / 3
    out[..., 1] += -2 * m / 3
    out[..., 2] += -w / 2 + m / 3

    if params["saturation"] != 1.0:
        lab = space.lin_to_oklab(space.decode(np.clip(out, 0, 1)))
        lab[..., 1:] *= params["saturation"]
        out = space.encode(np.clip(space.oklab_to_lin(lab), 0, None)).astype(np.float32)

    return np.clip(out, 0.0, 1.0)


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


def chroma_denoise(enc, strength, space: RGBSpace):
    """Blur only the colour (Oklab a/b), keep lightness and its detail.

    The radius scales with image size, so a preview and the full-resolution
    export look the same. Edges come from the lightness channel, so colour
    does not bleed across them.
    """
    if strength <= 0:
        return enc
    lab = space.lin_to_oklab(space.decode(enc)).astype(np.float32)
    radius = max(1, int(round(strength * max(enc.shape[:2]) / 600)))
    L = lab[..., 0]
    for i in (1, 2):
        lab[..., i] = _guided(L, lab[..., i], radius, 1e-3)
    return space.encode(np.clip(space.oklab_to_lin(lab), 0, None)).astype(np.float32)
