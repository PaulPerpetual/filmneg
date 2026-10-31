"""Reading scans and writing 16-bit TIFFs with their colour profile."""
from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image, ImageCms

from .color import SRGB, RGBSpace, space_from_profile_name


@dataclass
class Scan:
    path: Path
    rgb: np.ndarray          # float32, encoded values 0..1, (H, W, 3)
    icc: bytes | None
    space: RGBSpace
    profile_name: str | None


def _profile_name(icc):
    if not icc:
        return None
    try:
        return ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(icc))).strip()
    except Exception:
        return None


def load(path) -> Scan:
    path = Path(path)
    icc = None
    if path.suffix.lower() in (".tif", ".tiff"):
        with tifffile.TiffFile(path) as tif:
            page = tif.pages[0]
            data = page.asarray()
            tag = page.tags.get("InterColorProfile")
            if tag is not None:
                icc = bytes(tag.value)
    else:
        im = Image.open(path)
        icc = im.info.get("icc_profile")
        data = np.asarray(im.convert("RGB"))

    if data.ndim == 2:
        data = np.stack([data] * 3, axis=-1)
    data = data[..., :3]
    scale = float(np.iinfo(data.dtype).max) if np.issubdtype(data.dtype, np.integer) else 1.0
    rgb = (data.astype(np.float32) / scale)
    name = _profile_name(icc)
    return Scan(path, rgb, icc, space_from_profile_name(name), name)


def save_tiff16(path, rgb, icc=None):
    data = np.round(np.clip(rgb, 0, 1) * 65535).astype(np.uint16)
    extratags = [(34675, 7, len(icc), icc, True)] if icc else []
    tifffile.imwrite(path, data, photometric="rgb", extratags=extratags)


def downsample(rgb, long_side):
    """Area-average downscale (no-op if already small enough)."""
    h, w = rgb.shape[:2]
    f = int(np.ceil(max(h, w) / long_side))
    if f <= 1:
        return rgb
    h2, w2 = h // f * f, w // f * f
    return rgb[:h2, :w2].reshape(h2 // f, f, w2 // f, f, 3).mean(axis=(1, 3)).astype(np.float32)


_SRGB_ICC = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def to_srgb(rgb, space: RGBSpace):
    """Encoded values in the scan's space -> encoded sRGB, in float (no banding)."""
    if space is SRGB:
        return rgb
    lin = space.decode(np.clip(rgb, 0, 1)) @ (np.linalg.inv(SRGB.to_xyz) @ space.to_xyz).T
    return SRGB.encode(np.clip(lin, 0, 1))


def to_jpeg(rgb, space: RGBSpace | None = None, quality=90):
    """Preview JPEG, already converted to sRGB and tagged as such. Browsers then
    show it right however they handle profiles; Safari in particular doesn't
    reliably colour-manage images drawn on a canvas, which the viewer does."""
    if space is not None:
        rgb = to_srgb(rgb, space)
    buf = io.BytesIO()
    im = Image.fromarray(np.round(np.clip(rgb, 0, 1) * 255).astype(np.uint8))
    im.save(buf, "JPEG", quality=quality, icc_profile=_SRGB_ICC)
    return buf.getvalue()
