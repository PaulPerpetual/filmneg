"""Colour spaces: transfer functions, RGB -> XYZ, Oklab.

Everything works on float arrays shaped (..., 3).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# Oklab (Björn Ottosson, 2020), XYZ (D65) -> LMS and LMS' -> Lab.
_OKLAB_M1 = np.array([
    [0.8189330101, 0.3618667424, -0.1288597137],
    [0.0329845436, 0.9293118715, 0.0361456387],
    [0.0482003018, 0.2643662691, 0.6338517070],
])
_OKLAB_M2 = np.array([
    [0.2104542553, 0.7936177850, -0.0040720468],
    [1.9779984951, -2.4285922050, 0.4505937099],
    [0.0259040371, 0.7827717662, -0.8086757660],
])


@dataclass(frozen=True)
class RGBSpace:
    name: str
    to_xyz: np.ndarray
    gamma: float | None  # pure power law; None means the sRGB piecewise curve

    def decode(self, v):
        """Encoded (as stored in the file) -> linear light."""
        v = np.clip(v, 0.0, None)
        if self.gamma is not None:
            return v ** self.gamma
        return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)

    def encode(self, v):
        """Linear light -> encoded."""
        v = np.clip(v, 0.0, None)
        if self.gamma is not None:
            return v ** (1.0 / self.gamma)
        return np.where(v <= 0.0031308, v * 12.92, 1.055 * v ** (1 / 2.4) - 0.055)

    def lin_to_oklab(self, lin):
        lin = np.asarray(lin)
        dt = lin.dtype if lin.dtype in (np.float32, np.float64) else np.float64
        lms = lin @ (_OKLAB_M1 @ self.to_xyz).T.astype(dt)
        return np.cbrt(lms) @ _OKLAB_M2.T.astype(dt)

    def oklab_to_lin(self, lab):
        lab = np.asarray(lab)
        dt = lab.dtype if lab.dtype in (np.float32, np.float64) else np.float64
        lms = (lab @ np.linalg.inv(_OKLAB_M2).T.astype(dt)) ** 3
        return lms @ np.linalg.inv(_OKLAB_M1 @ self.to_xyz).T.astype(dt)


ADOBE_RGB = RGBSpace(
    "Adobe RGB (1998)",
    np.array([
        [0.5767309, 0.1855540, 0.1881852],
        [0.2973769, 0.6273491, 0.0752741],
        [0.0270343, 0.0706872, 0.9911085],
    ]),
    563 / 256,
)

SRGB = RGBSpace(
    "sRGB",
    np.array([
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ]),
    None,
)


# the screens of recent Macs: P3 primaries, D65, the sRGB tone curve
DISPLAY_P3 = RGBSpace(
    "Display P3",
    np.array([
        [0.4865709, 0.2656677, 0.1982173],
        [0.2289746, 0.6917385, 0.0792869],
        [0.0000000, 0.0451134, 1.0439444],
    ]),
    None,
)

def space_from_profile_name(name: str | None) -> RGBSpace:
    if name and "adobe" in name.lower():
        return ADOBE_RGB
    return SRGB


def luma(enc):
    """Rec. 709 weighted sum of encoded values: a cheap 'tone' position in 0..1."""
    return enc @ np.array([0.2126, 0.7152, 0.0722])


# Typical skin tones (sRGB 8-bit), light to dark. Skin hue is fairly constant
# across people; lightness and chroma vary a lot more. Used as a hue target.
_SKIN_SRGB = np.array([
    [255, 219, 172], [224, 172, 140], [198, 134, 103],
    [160, 110, 80], [141, 85, 36], [105, 60, 40],
]) / 255.0


def _skin_hue():
    lab = SRGB.lin_to_oklab(SRGB.decode(_SKIN_SRGB))
    angles = np.arctan2(lab[:, 2], lab[:, 1])
    return float(np.arctan2(np.sin(angles).mean(), np.cos(angles).mean()))


SKIN_HUE = _skin_hue()  # radians in the Oklab a/b plane
