# filmneg

Colour correction for film scans, built around a back-and-forth between the
computer and your eye. It runs locally on your Mac: a small Python engine plus
a browser UI.

The engine fixes what is physical (casts that change with brightness, the
scanner's per-channel clipping) with as small and smooth a change as possible.
The aesthetic decisions stay with you: a ring-around grid of variants, gentle
colour pushes straight on the image, and curves that show the change magnified.

## Setup

Python 3.10 or newer.

```sh
git clone https://github.com/PaulPerpetual/filmneg.git
cd filmneg
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
```

## Use

```sh
filmneg ~/Scans/roll-12            # a folder of TIFFs
filmneg ~/Scans/roll-12/frame03.tif
```

Your browser opens at `http://127.0.0.1:8765`. Edits are saved next to each
scan as `frame03.tif.filmneg.json` (the scan itself is never touched). Export
writes `frame03_filmneg.tif`, 16-bit, with the scan's colour profile, ready
for Pixelmator.

### A good order of work

1. **Auto** detects the crop and sets each channel's black and white point
   from the histogram. It runs by itself the first time you open a scan.
2. Click a few **Grey** areas at different brightness (a wall in light, the
   same wall in shade, a dark grey), plus **White** and **Black** if there are
   any, and **Skin** if there are people. Then **Solve samples**. Each sample
   shows how far it still is from neutral, so you can remove one that wasn't
   really grey.
3. **Straighten casts** bends the warmth/tint curves so near-neutral areas
   stay neutral from shadows to highlights. Watch the *cast vs. tone* scope
   flatten.
4. Set **Light** if the picture should keep its light (golden hour, tungsten,
   shade), then solve again.
5. Open **Variants** (V) and pick the version you like best. The centre is the
   current one; opposite cells are opposite moves. Picking the centre makes the
   steps finer. Repeat until nothing beats the centre.
6. Fine-tune by hand with **Push** or the curves.

### Tools and keys

| Key | Tool |
|---|---|
| P | Probe: shows the area's values, its cast, and where it sits on the curves |
| C | Push: click a spot, drag towards a colour on the wheel. Bends warmth/tint gently at that brightness only; the further you drag, the stronger. Scroll to change how wide a brightness range it affects, hold ⌥ for finer |
| N / W / K / S | Add grey / white / black / skin sample (⇧-click a sample to remove it) |
| R | Crop |
| V | Variants grid |
| \\ (hold) | Before: the scan as the scanner delivered it |
| ⌘Z / ⇧⌘Z | Undo / redo |

### Curves

- **Colour** shows warmth (yellow/blue) and tint (magenta/green) as a function
  of brightness. Drag up/down for warmth, left/right for tint, at the
  brightness where you click. This is the panel for "the shadows are too red".
- **Light, R, G, B** are classic curves, but drawn as the *change* from
  neutral, magnified (±5 to ±40 levels), so small moves are visible.
- Dragging never places points: the change falls off smoothly around where you
  grab. Grab near the middle line to pull a narrow range of tones, near the top
  or bottom edge for a broad one (scroll scales it). The background shows which
  colour each direction moves the image towards, and while you drag in the
  Colour panel a swatch shows the exact colour of the push. Curves are B-splines whose control points sit
  off the curve, like NURBS in Rhino, so they can't kink. The faint hairlines
  are a curvature comb: bumps there mean bumps in the tones.
- The x-axis is labelled in zones (I to IX).

## How it works

```
scan (encoded) -> linear light
  -> [negative mode: divide by film base, invert]
  -> per-channel levels (black/white points, linear)
  -> log2 domain: per-channel slope + offset, contrast, exposure
  -> soft highlight shoulder -> encode
  -> curves: lightness, R/G/B, warmth/tint by tone
  -> saturation (Oklab)
```

**Crossover.** The three dye layers of a colour film have slightly different
contrast, so after inversion the cast changes with brightness: neutral mids,
red shadows, cyan highlights. One white balance can't fix that. In the log
domain each channel needs only an offset and a slope; *Solve samples* fits
those for red and blue (green is the reference) by least squares through all
your samples, with a penalty for moving far from where you are. With one
sample it reduces to a white balance.

**Skin.** Skin hue is quite consistent across people; lightness and chroma
vary much more. Skin samples are therefore a hue target (the "skin line" on the
vectorscope), not a colour target.

**Straighten.** Measures the average cast of near-neutral pixels per
brightness band and bends the warmth/tint curves against it, smoothed so the
correction stays a gentle curve.

**Variants.** Four meaningful directions (exposure, contrast, saturation, or
warmth/tint in shadows, mids or highlights), each pushed both ways around the
current image. Directions you choose come up more often; the step shrinks when
you keep the centre and grows when you keep going the same way. It's the
darkroom ring-around, plus a little memory.

**Speed.** The per-channel stages are baked into a 16-bit lookup table per
channel, so a preview renders in well under 0.1 s. Chroma noise reduction (an
edge-aware blur of the Oklab colour channels only, radius scaled to the image
size) is cached per strength.

**Scans that are already positive.** Most lab and Flextight scans come
already inverted. That works (it's the default `positive` mode), but the
scanner has already made some decisions and may have clipped channels. If you
can get un-inverted negative scans, set `"mode": "negative"` in the sidecar
(UI support to follow).

## Develop

```sh
pip install -e '.[dev]'
pytest
```

Code map: `filmneg/pipeline.py` (render), `analysis.py` (auto crop/levels,
solver, straighten, probe), `variants.py` (ring-around), `curves.py`
(B-splines), `server.py` (local HTTP API), `web/` (UI, plain JS, no build step).
