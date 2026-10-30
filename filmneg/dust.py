"""Dust and hair removal for scans made without an infrared dust channel.

Dust on a negative blocks light, so on a scan the scanner already inverted it
shows as small bright specks and thin bright hairs. `find` lists candidates,
each with a confidence that it is dust rather than picture (a catch light, a
star, a bright window); `heal` fills the chosen ones from a nearby patch of
the same image, so the grain carries on through the repair.

Spots live in fractions of the unrotated scan, so they survive crop and
straighten changes. Each has a box and, when detected, a small bitmap of its
exact shape inside that box.
"""
import base64

import numpy as np
from scipy import ndimage as ndi

DETECT = 4000      # detection runs on a copy this size (long side)
OPEN = 11          # widest speck or hair found, in detection pixels
HIGH, LOW = 0.035, 0.014  # top-hat thresholds (encoded units): seed / extent
MAX_AREA = 4000    # bigger bright shapes are picture, not dust
TILE = 32          # repairs work on pieces of at most this many pixels


def _luma(rgb):
    return rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def _downsample(rgb, long_side):
    h, w = rgb.shape[:2]
    f = int(np.ceil(max(h, w) / long_side))
    if f <= 1:
        return rgb, 1
    h2, w2 = h // f * f, w // f * f
    return rgb[:h2, :w2].reshape(h2 // f, f, w2 // f, f, -1).mean(axis=(1, 3)), f


def _pack(mask):
    return base64.b64encode(np.packbits(mask.astype(np.uint8)).tobytes()).decode()


def _unpack(s, h, w):
    bits = np.unpackbits(np.frombuffer(base64.b64decode(s), np.uint8))
    return bits[:h * w].reshape(h, w).astype(bool)


def find(rgb, region=(0.0, 0.0, 1.0, 1.0)):
    """Dust candidates in region (fractions), most confident first.

    A white top-hat (the image minus its grey opening) keeps only bright
    things narrower than OPEN pixels. Its strength is compared with the grain
    around each spot, and spots on smooth ground (sky, walls, skin) count as
    more likely dust than spots in busy texture, where catch lights live.
    """
    small, f = _downsample(np.asarray(rgb, np.float32), DETECT)
    H, W = rgb.shape[:2]
    h, w = small.shape[:2]
    L = _luma(small).astype(np.float32)
    opened = ndi.grey_opening(L, size=(OPEN, OPEN))
    top = L - opened
    grain = ndi.uniform_filter(top, 41) + 0.004          # typical top-hat of the grain nearby
    m1 = ndi.uniform_filter(opened, 31)
    texture = np.sqrt(np.maximum(ndi.uniform_filter(opened * opened, 31) - m1 * m1, 0))

    x0, y0, x1, y1 = region
    inside = np.zeros_like(top, bool)
    inside[int(y0 * h) + 2:int(np.ceil(y1 * h)) - 2, int(x0 * w) + 2:int(np.ceil(x1 * w)) - 2] = True
    seed = (top > HIGH) & (top / grain > 4) & inside
    extent = (top > LOW) & (top / grain > 1.8)
    labels, n = ndi.label(extent, structure=np.ones((3, 3)))
    keep = np.unique(labels[seed])
    keep = keep[keep > 0]

    spots = []
    objs = ndi.find_objects(labels)
    for lab in keep:
        sl = objs[lab - 1]
        m = labels[sl] == lab
        area = int(m.sum())
        if area > MAX_AREA:
            continue
        t = top[sl][m]
        peak = float(t.max())
        z = float((t / grain[sl][m]).max())
        tex = float(texture[sl].max())
        bh, bw = m.shape
        length = float(np.hypot(bh, bw))
        thick = area / max(length, 1.0)              # about the width of the shape
        hair = thick <= 3.0 and length >= 14         # long and thin
        score = (1.3 * np.log(z / 4) + 8 * (peak - HIGH) - 40 * tex
                 + (0.3 if area >= 3 else -0.8)
                 + (0.8 if hair else -1.2 * max(0.0, np.log2(area / 40))))  # big blobs are mostly picture
        conf = float(1 / (1 + np.exp(-1.5 * score)))
        # one pixel of margin: the soft edge of the speck
        m = np.pad(m, 1)
        ys, xs = sl[0].start - 1, sl[1].start - 1
        spots.append({
            "box": [xs * f / W, ys * f / H, (xs + m.shape[1]) * f / W, (ys + m.shape[0]) * f / H],
            "mask": _pack(m), "mw": m.shape[1], "mh": m.shape[0],
            "conf": round(conf, 3), "kind": "hair" if hair else "speck",
        })
    spots.sort(key=lambda s: -s["conf"])
    for i, s in enumerate(spots):
        s["id"] = i + 1
    return spots


def healed(spots, threshold):
    """The spots to repair: switched on by hand, or confident enough and not switched off."""
    return [s for s in spots if s.get("on") or (s.get("on") is None and s["conf"] >= threshold)]


def spot_mask(spot, H, W):
    """(y0, x0, mask) of a spot at an image of H x W pixels, grown a little for safety."""
    x0, y0, x1, y1 = spot["box"]
    px0, py0 = int(np.floor(x0 * W)), int(np.floor(y0 * H))
    px1, py1 = max(px0 + 1, int(np.ceil(x1 * W))), max(py0 + 1, int(np.ceil(y1 * H)))
    bh, bw = py1 - py0, px1 - px0
    if spot.get("mask"):
        m = _unpack(spot["mask"], spot["mh"], spot["mw"])
        iy = np.minimum((np.arange(bh) + 0.5) * spot["mh"] / bh, spot["mh"] - 1).astype(int)
        ix = np.minimum((np.arange(bw) + 0.5) * spot["mw"] / bw, spot["mw"] - 1).astype(int)
        m = m[iy][:, ix]
    else:  # drawn by hand: an ellipse filling the box
        yy, xx = np.mgrid[0:bh, 0:bw]
        m = ((yy + 0.5 - bh / 2) / (bh / 2)) ** 2 + ((xx + 0.5 - bw / 2) / (bw / 2)) ** 2 <= 1
    grow = 1 if max(H, W) <= 2000 else 2
    m = np.pad(m, grow)
    m = ndi.binary_dilation(m, iterations=grow)
    return py0 - grow, px0 - grow, m


def patches(img, spots, avoid=()):
    """{spot id: (y0, x0, values, alpha)}: each spot's repair, computed from img.

    Each repair clones the best-matching nearby patch, compared on a ring just
    outside the spot; the clone is then shifted by the smooth difference along
    that ring, like a healing brush, so brightness and colour meet without a
    seam. Repairs never clone from a spot in avoid (other dust), so they don't
    depend on each other and can be switched on and off freely.
    """
    img = np.asarray(img, np.float32)
    H, W = img.shape[:2]
    busy = np.zeros((H, W), bool)
    for y0, x0, m in (spot_mask(s, H, W) for s in list(avoid) + list(spots)):
        _paste_or(busy, y0, x0, m)
    out = {}
    for s in spots:
        y0, x0, m = spot_mask(s, H, W)
        # long hairs are repaired piece by piece, so each piece finds a close match
        out[s["id"]] = [p for ty in range(0, m.shape[0], TILE) for tx in range(0, m.shape[1], TILE)
                        if m[ty:ty + TILE, tx:tx + TILE].any()
                        for p in [_patch(img, busy, y0 + ty, x0 + tx, m[ty:ty + TILE, tx:tx + TILE])] if p]
    return out


def apply(img, patch_list):
    """img with the given repairs pasted in (a copy)."""
    out = np.array(img, np.float32, copy=True)
    for y0, x0, values, alpha in patch_list:
        t = out[y0:y0 + values.shape[0], x0:x0 + values.shape[1]]
        t[...] = t * (1 - alpha) + values * alpha
    return out


def heal(img, spots, avoid=()):
    return apply(img, [p for ps in patches(img, spots, avoid).values() for p in ps])


def _paste_or(dst, y0, x0, m):
    H, W = dst.shape
    ya, xa = max(0, y0), max(0, x0)
    yb, xb = min(H, y0 + m.shape[0]), min(W, x0 + m.shape[1])
    if ya < yb and xa < xb:
        dst[ya:yb, xa:xb] |= m[ya - y0:yb - y0, xa - x0:xb - x0]


def _patch(img, busy, y0, x0, m):
    H, W = img.shape[:2]
    size = max(m.shape)
    thick = m.sum() / size  # about the width of a speck or hair
    ring_w = int(np.clip(thick, 2, 6))
    pad = ring_w + 1
    m = np.pad(m, pad)
    y0, x0 = y0 - pad, x0 - pad
    mh, mw = m.shape
    if y0 < 0 or x0 < 0 or y0 + mh > H or x0 + mw > W:
        return None  # at the very edge of the scan: leave it
    # compare and blend only on clean ground: not on this spot, nor on other dust
    ring = ndi.binary_dilation(m, iterations=ring_w) & ~m & ~busy[y0:y0 + mh, x0:x0 + mw]
    if ring.sum() < 4:
        return None
    t_ring = img[y0:y0 + mh, x0:x0 + mw][ring]
    ry, rx = np.nonzero(ring)
    my, mx = np.nonzero(m)
    def best(ya, yb, xa, xb, step):
        """Cheapest window with its corner in [ya, yb) x [xa, xb), on a grid of step."""
        oy, ox = np.arange(max(0, ya), min(H - mh, yb - 1) + 1, step), np.arange(max(0, xa), min(W - mw, xb - 1) + 1, step)
        if not len(oy) or not len(ox):
            return None
        cand = img[oy[:, None, None] + ry, ox[None, :, None] + rx]  # ring pixels of each window
        d = cand - t_ring
        cost = (d * d).sum(axis=(2, 3)) + 0.5 * (d.mean(axis=2) ** 2).sum(axis=2) * len(ry)
        hits = busy[oy[:, None, None] + my, ox[None, :, None] + mx].any(axis=2)
        near = (np.abs(oy[:, None] - y0) < size + 1) & (np.abs(ox[None, :] - x0) < size + 1)
        cost[hits | near] = np.inf
        if not np.isfinite(cost).any():
            return None
        i, j = np.unravel_index(np.argmin(cost), cost.shape)
        return oy[i], ox[j]

    found = None
    for radius in (1.5, 3.0, 5.0):
        rr = int(radius * size) + 3
        step = max(2, size // 4)
        found = best(y0 - rr, y0 + rr + 1, x0 - rr, x0 + rr + 1, step)
        if found:  # refine around the coarse winner
            fy, fx = found
            found = best(fy - step + 1, fy + step, fx - step + 1, fx + step, 1) or found
            break
    if found is None:
        return None
    sy, sx = found
    src = img[sy:sy + mh, sx:sx + mw].copy()
    # the smooth difference along the ring, spread inwards (normalised convolution)
    sigma = max(1.0, size / 3)
    wgt = ndi.gaussian_filter(ring.astype(np.float32), sigma)
    diff = np.zeros_like(src)
    diff[ring] = t_ring - src[ring]
    for c in range(src.shape[2]):
        diff[..., c] = ndi.gaussian_filter(diff[..., c], sigma) / np.maximum(wgt, 1e-4)
    alpha = np.clip(ndi.gaussian_filter(m.astype(np.float32), 0.6) * 1.6, 0, 1)[..., None]
    return y0, x0, src + diff, alpha


def mask_image(spots, H, W):
    """Full-size 8-bit mask of the repaired spots (white), for other editors."""
    out = np.zeros((H, W), bool)
    for y0, x0, m in (spot_mask(s, H, W) for s in spots):
        _paste_or(out, y0, x0, m)
    return (out * 255).astype(np.uint8)
