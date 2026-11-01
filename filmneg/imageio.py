"""Reading scans and writing 16-bit TIFFs with their colour profile."""
from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image, ImageCms

from .color import DISPLAY_P3, SRGB, RGBSpace, space_from_profile_name


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




def matrix_icc(desc: str, space: RGBSpace) -> bytes:
    """A small ICC v2 display profile (matrix + tone curve) for an RGB space,
    as Display P3 has no built-in profile in Pillow."""
    import struct
    brad = np.array([[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]])
    d50 = np.array([0.9642, 1.0, 0.8249])
    white = space.to_xyz.sum(axis=1)
    adapt = np.linalg.inv(brad) @ np.diag((brad @ d50) / (brad @ white)) @ brad
    m = adapt @ space.to_xyz  # the primaries as seen under D50, as ICC wants them
    s15 = lambda v: struct.pack(">i", int(round(v * 65536)))
    xyz = lambda v: b"XYZ " + bytes(4) + b"".join(s15(c) for c in v)
    x = np.linspace(0, 1, 1024)
    curve = np.clip(space.decode(x) * 65535 + 0.5, 0, 65535).astype(">u2").tobytes()
    text = desc.encode("ascii")
    tags = [
        (b"desc", b"desc" + bytes(4) + struct.pack(">I", len(text) + 1) + text + b"\0" + bytes(8) + bytes(3) + bytes(67)),
        (b"cprt", b"text" + bytes(4) + b"No copyright\0"),
        (b"wtpt", xyz(d50)),
        (b"rXYZ", xyz(m[:, 0])), (b"gXYZ", xyz(m[:, 1])), (b"bXYZ", xyz(m[:, 2])),
        (b"rTRC", b"curv" + bytes(4) + struct.pack(">I", 1024) + curve),
    ]
    table, data, off = [], b"", 128 + 4 + 12 * (len(tags) + 2)
    for sig, d in tags:
        table.append((sig, off + len(data), len(d)))
        data += d + bytes(-len(d) % 4)
    trc = table[-1]
    table += [(b"gTRC", trc[1], trc[2]), (b"bTRC", trc[1], trc[2])]  # one curve for all three
    body = struct.pack(">I", len(table)) + b"".join(sig + struct.pack(">II", o, n) for sig, o, n in table) + data
    size = 128 + len(body)
    header = (struct.pack(">I", size) + b"lcms" + bytes([2, 0x10, 0, 0]) + b"mntrRGB XYZ " + bytes(12) + b"acsp"
              + b"APPL" + bytes(4) + bytes(8) + bytes(8) + bytes(4) + b"".join(s15(c) for c in d50) + bytes(4) + bytes(16) + bytes(28))
    assert len(header) == 128
    return header + body


_SRGB_ICC = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
_P3_ICC = matrix_icc("Display P3", DISPLAY_P3)
DISPLAYS = {"srgb": (SRGB, _SRGB_ICC), "p3": (DISPLAY_P3, _P3_ICC)}


def to_display(rgb, space: RGBSpace, display: RGBSpace = SRGB):
    """Encoded values in the scan's space -> encoded display space, in float (no banding)."""
    if space is display:
        return rgb
    lin = space.decode(np.clip(rgb, 0, 1)) @ (np.linalg.inv(display.to_xyz) @ space.to_xyz).T
    return display.encode(np.clip(lin, 0, 1))


def to_srgb(rgb, space: RGBSpace):
    return to_display(rgb, space, SRGB)


def to_jpeg(rgb, space: RGBSpace | None = None, quality=90, display="srgb"):
    """Preview JPEG, already converted to the display space (sRGB, or Display P3
    on wide-gamut Macs, so saturated colours aren't clipped to sRGB) and tagged as
    such. Browsers then show it right however they handle profiles."""
    disp, icc = DISPLAYS.get(display, DISPLAYS["srgb"])
    if space is not None:
        rgb = to_display(rgb, space, disp)
    buf = io.BytesIO()
    im = Image.fromarray(np.round(np.clip(rgb, 0, 1) * 255).astype(np.uint8))
    im.save(buf, "JPEG", quality=quality, icc_profile=icc)
    return buf.getvalue()
