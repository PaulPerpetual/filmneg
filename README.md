# filmneg

Colour correction for film scans, built around a back-and-forth between the
computer and your eye. It runs locally on your Mac: a small Python engine plus
a browser UI.

The engine fixes what is physical (casts that change with brightness, the
scanner's per-channel clipping) with as small and smooth a change as possible.
The aesthetic decisions stay with you: gentle colour pushes straight on the
image, classic levels, and curves that show the change magnified.

## Setup

Python 3.9 or newer (the one that comes with macOS works).

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
3. Set **Light** if the picture should keep its light (golden hour, tungsten,
   shade), then solve again.
4. Set black and white points in **Levels** if the scan needs it.
5. Fine-tune by hand with **Shift colour**, **Shift brightness** or the curves.

### Tools and keys

| Key | Tool |
|---|---|
| P | Measure: click a spot or drag an area. Measured points stay pinned (P1, P2, …), update after every edit and are marked on the curves. hover one and click its × (or press Delete) to remove it, drag to move it |
| C | Shift colour: click a spot, drag towards a colour on the wheel. Bends warmth/tint gently at that brightness only; the further you drag, the stronger. The parts of the image it leaves alone are veiled while you drag |
| L | Shift brightness: same, but drag up to brighten or down to darken that brightness |
| [ / ] | Narrower / wider Shift colour and Shift brightness |
| pinch, ⌘+ / ⌘−, 0 | Zoom (zoomed-in detail is rendered from full resolution), fit. Two-finger scroll moves around |
| N / W / K / S | Grey / white / black / skin sample: click for one point, click and drag for an area (dust specks inside are ignored). Drag a sample to move it; hover it and click its × (or press Delete) to remove it |
| R | Crop. The bar on top rotates (angle slider, or type it), *Level by line* straightens along a line you draw (a horizon, a wall edge), *Reset* goes back to the automatic crop |
| right-click | Background colour around the picture (white, mid grey, dark), fit |
| \\ (hold) | Before: the scan as the scanner delivered it |
| ⌘Z / ⇧⌘Z or ⌘Y | Undo / redo (a short note on the image says what was undone) |

Hover a sample or measured point (on the image or in its list) to highlight
it; its red × or the Delete key removes it, dragging moves it. Under the
samples, **Colour casts left** says in words what cast remains in the
shadows, midtones and highlights (from your grey samples where there are
some, otherwise from grey-ish areas of the picture) and what would fix it.

The numbers next to the Base sliders are fields: click one, then ↑/↓ steps
by 0.1 and ←/→ by 0.01 (⇧ for ten times that), or type a value and press
Enter. Double-click a slider to reset it.

**Highlights** and **Shadows** in Base set how gently the brightest parts
roll off into white and the darkest into black.

**Roll workflow.** *Copy settings* (⇧⌘C) takes this frame's adjustments,
*Paste* (⇧⌘V) puts them on another frame, *Paste to roll…* on every other
frame in the folder. Crop, rotation and each frame's automatic black/white
points are not copied. A frame that already had edits keeps them as a version
called "Before paste".

**Versions.** *Save current as version* keeps the adjustments; click a version
to switch to it (undo goes back), double-click its name to rename it.

Click a panel's title to fold it away. The eye in the Samples and Measure
panels hides those marks on the image. Samples are round with a numbered
badge; measured points are square (a crosshair, or corner brackets for an
area) and labelled P1, P2, …

### Levels

Classic levels, like Pixelmator Pro's: a histogram of the image before levels
and curves, black / grey / white input triangles under it, and output black and
white on the bar below. **RGB** moves all three channels, **R**, **G**, **B**
one each (a channel's levels apply first, then RGB). The number fields take
exact values. Clicking anywhere in the histogram moves the nearest triangle
there. To fine-tune clipping, zoom in: pinch over the histogram, use the
magnifier (click to zoom in, ⌥-click out, double-click for everything) or
pick Shadows / Highlights in the menu. Scroll sideways to move along. A drag
then moves the triangles in finer steps, and a click still places a triangle
that is out of view.
While you drag the black or white point, the image shows what gets clipped
(red = white, blue = black), like Lightroom's clipping warning. The panel also says how much is
clipped.

### Curves

- **Colour** shows warmth (yellow/blue) and tint (magenta/green) as a function
  of brightness. Pick Yellow/Blue or Magenta/Green in the menu next to the tab, then drag up or down. This is the panel
  for "the shadows are too red".
- The histogram of the current image sits behind the curves.
- **Smooth** (under the curves) relaxes the shown curve(s), like Rhino's
  Smooth. Click again for more. **Reset curve** or a double-click clears them.
- **Light, R, G, B** are classic curves, but drawn as the *change* from
  neutral, magnified (±5 to ±40 levels), so small moves are visible.
- Dragging never places points: the change falls off smoothly around where you
  grab. Press right on the curve for a narrow change, further away from it
  for a broader one; the shaded bell shows what will move. The background shows which
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
  -> levels: per channel, then RGB (input black/grey/white, output black/white)
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
vary much more. Skin samples are therefore a hue target, not a
colour target.

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
solver, cast report, probe), `curves.py`
(B-splines), `server.py` (local HTTP API), `web/` (UI, plain JS, no build step).
