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

1. **Auto** sets each channel's black and white point (crop is detected on first open; Reset in crop mode re-detects it)
   from the histogram. It runs by itself the first time you open a scan.
2. Click a few **Grey** areas at different brightness (a wall in light, the
   same wall in shade, a dark grey), and **Skin** if there are people. Then
   **Solve** (in the Points panel). Each sample shows how far it still is from
   right, so you can remove one that wasn't really grey. Solve changes only
   things you can see and readjust by hand: greys and skin bend the **Colour
   by tone** curves (gently, around the samples' brightness), **White** and
   **Black** samples work like the eyedroppers in a classic Levels and set the
   R, G and B input white / black points in **Levels** so that spot becomes
   neutral white / black (anything brighter / darker clips). Brightness, the
   Light curve and Base (exposure, contrast, …) are never touched.
3. Set the **White balance** (the panel under Points): what Solve makes your
   greys look like. Pure grey, or keeping the light the picture was taken
   in: the **Light** menu picks shade, daylight, golden hour or tungsten,
   **Warmth** sets anything in between (the menu then says Custom), **Tint**
   leans green or magenta. **By brightness** leans highlights, midtones and
   shadows on their own, e.g. warm highlights with neutral shadows. With
   samples placed, every change solves again at once.
4. Set black and white points in **Levels** if the scan needs it.
5. Fine-tune by hand with **Shift colour**, **Shift brightness** or the curves.

### Tools and keys

| Key | Tool |
|---|---|
| P | Measure: click a spot or drag an area to pin a point that is only read (see Points). Points update after every edit and are marked on the curves. Hover one and click it to remove it (or press Delete), drag to move it |
| C | Shift colour (the target button in Colour by tone): click a spot, drag towards a colour on the wheel. Bends warmth/tint gently at that brightness only; the further you drag, the stronger. Its bell shows in the Colour by tone panel while you drag |
| L | Shift brightness (the target button in Curves): same, but drag up to brighten or down to darken that brightness |
| [ / ] | Narrower / wider Shift colour and Shift brightness |
| pinch, ⌘+ / ⌘−, 0 | Zoom (zoomed-in detail is rendered from full resolution), fit. Two-finger scroll moves around |
| N / W / K / S | Grey / white / black / skin sample: click for one point, click and drag for an area (dust specks inside are ignored). Drag a sample to move it; hover it and click to remove it (or press Delete) |
| R | Crop & straighten: the sidebar shows angle, *Level by line* (draw along a horizon or wall edge), aspect ratio (6×7, 4×5, …), lens distortion and *Reset*. Drag the corners or edges to fine-tune, inside to move; a press outside the crop pulls the nearest edge there, ⇧-drag draws a new crop, dragging outside the picture rotates (⌥ finer). Leave with Done |
| D | Dust: find dust and hairs, review the ranked list, repair (see below) |
| right-click | Background colour around the picture (white, mid grey, dark), fit |
| \\ (hold) | Before: the scan as the scanner delivered it |
| ⌘Z / ⇧⌘Z or ⌘Y | Undo / redo (a short note on the image says what was undone) |

Hover a point (on the image or in its list) to highlight it: a small grey ×
badge appears, a click removes it (no modifier key), a drag moves it, and the
Delete key works too.

### Points

Measured points and samples are one list in the **Points** panel, numbered 1,
2, … on the image and on the curves. Click a row to see the point: change
its role (*Measure only*, *Grey*, *White*, *Black*, *Skin*) and read what it
is now (R/G/B, brightness and zone, colour in words, how it compares with
skin). **Solve** makes every sample right (see step 2). Under the list, **Casts
left** says in words what cast remains in the shadows, midtones and
highlights (from your grey samples where there are some, otherwise from
grey-ish areas of the picture).

**Correct just here** has a slider per cast: *Blue ↔ yellow* and *Green ↔
magenta* (for a skin point, *Pink ↔ yellow* against typical skin). The middle
is neutral, and the knob sits where the point's cast is now, so drag it
toward the middle to correct, or double-click to make it neutral. It bends
the Colour by tone curves around that point's brightness only; its reach is
the Shift colour width (`[` `]`).

### Zones

Under **Curves**, on the **Light** tab, each point can be given the zone it
belongs in. The zones are Ansel Adams' (each listed with what typically sits
there: V grey card, grass, darker skin; VI light skin in sun; VIII textured
snow, …). The Light curve bends, as simply and smoothly as it can, to put
each point with a zone there (zone n at brightness n/10, as marked under the
curves). Only brightness changes: colour stays as it is. The curve always
keeps rising, so if two points are close in tone but far apart in zone, it
stops at a gentle compromise and the point shows in orange.

The switch in the title of Base, Levels, Curves and Colour by tone turns
that panel's adjustments off for a moment, to see what it does. It isn't
saved and doesn't touch the settings. Dust has its own *Repair here* switch.
The arrow next to it (also on White balance, and on the Vectorscope, where it centres
the colour wheels) **reverts** that panel to its defaults. ⌘Z brings it back.

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

Click a panel's title to fold it away. The eye in the Points panel hides the
points on the image. Samples are round with a numbered badge; points that are
only measured are square (a crosshair, or corner brackets for an area).

### Levels

**Auto** (in the panel) sets each channel's black and white point where its
histogram begins and ends (the last 0.01% is ignored, so a few hot pixels
don't count), with the grey point in the middle.

Classic levels, like Pixelmator Pro's: a histogram of the image before levels
and curves, black / grey / white input triangles under it, and output black and
white on the bar below. **RGB** moves all three channels, **R**, **G**, **B**
one each (a channel's levels apply first, then RGB). The number fields take
exact values. Clicking anywhere in the histogram moves the nearest triangle
there. To fine-tune clipping, zoom in: pinch over the histogram, use the
magnifier (click to zoom in, ⌥-click out, double-click for everything) or
pick Shadows / Highlights in the menu. Scroll sideways to move along. Hold ⌥ while dragging a triangle (black, grey, white or output) for fine
adjustment: it moves at a tenth of the speed, and you can press or let go of ⌥
mid-drag without the triangle jumping. A drag in a zoomed view
also moves the triangles in finer steps, and a click still places a triangle
that is out of view.
While you drag the black or white point, the image shows what gets clipped
(red = white, blue = black), like Lightroom's clipping warning. The panel also says how much is
clipped.

### Dust

The Flextight has no infrared dust channel, so filmneg finds dust in the
picture itself. On an inverted scan, dust and hairs are small bright specks
and thin bright lines. **Find dust** (in the Dust tool, D) looks inside the
crop and lists every candidate with how likely it is dust: specks and hairs on
smooth ground (sky, walls, skin) score high; bright details in busy texture
(catch lights, lettering, glass) score low.

- Spots from **Repair from** (60% by default) upwards are repaired until you
  decide them yourself. **Size** limits the list and the repairs to spots
  between two sizes (longest side in scan pixels, 2–150 by default; ↑/↓ in
  the fields step it).
- Reviewing: click a row, or walk the list with ↑/↓. The spot zooms to a
  comfortable size, the rest dims, corner brackets frame it and it shows
  **unrepaired**. **Return** shows the repair; **Return** again keeps it and moves
  to the next spot; **⌫** leaves it alone and moves on. Decided spots move
  down to *Kept* or *Left alone*. Esc goes back to the overview, where every
  spot has a circle (green repaired, dashed amber not); click one to switch it.
- The order of spots to review: *Least sure first* (closest to the Repair
  from line, where your eye matters most), *Most likely* or *Least likely first*.
- Every decision teaches the scores: spots that resemble what you rejected
  (contrast, size, shape, texture around them, brightness) drop, ones like
  what you kept rise. A few decisions nudge; they don't overturn the scores.
- **Clone stamp** for repairs that need a hand: ⌥-click a clean area to pick
  the source, then paint over the spot; the source follows the brush
  (aligned). `[` `]` change the brush, Esc drops the source. Each stroke is
  listed and removable (⌫) like a hand-marked spot.
- Click empty picture to mark a missed spot (drag for a bigger one).
- Hold `\` to compare with the unrepaired scan.
- A repair clones the best-matching patch nearby (compared on a ring around
  the spot, never taken from other dust) and evens out brightness and colour
  at the edge, like a healing brush, so the grain carries on. Long hairs are
  repaired piece by piece.
- **Export mask** saves `<scan>_filmneg_dust.png`, white where spots are
  marked, lined up with the exported TIFF, e.g. to use with Pixelmator Pro's
  Repair tool. Untick **Repair here** to only mark spots for the mask.
- Spots are stored in the sidecar in unrotated scan coordinates, so they stay
  put when you change the crop or angle. The exported TIFF includes the repairs.

### Vectorscope and colour wheels

The **Vectorscope** panel plots the colour of every pixel like DaVinci's: hue
round the circle, saturation outwards, each pixel glowing in its own colour,
faint colours behind to show which way is which, corner brackets for 75% red,
yellow, green, cyan, blue, magenta and a skin tone line. 2× (the default) or 4× magnify the middle, where
most film colours live.

Under it, three **colour wheels** (Shadows, Midtones, Highlights) are a
classic colour balance: drag the dot towards a colour (⌥ finer), double-click
to centre it. They are another handle on the Colour by tone curves: the dot
shows the curves' warmth and tint at that brightness, and dragging bends the
curves there, so brightness stays where it is.

### Curves and Colour by tone

- **Curves** (Light, R, G, B) shows the classic view by default: output over
  input with the diagonal, as in Photoshop or Lightroom. Pick ±5 … ±40 in the
  menu to see only the *change*, magnified, when you need to judge small moves.
- **Colour by tone** is its own panel: warmth (Yellow/Blue) and tint
  (Magenta/Green) as a function of brightness, always shown as the change.
  It changes colour only: brightness stays exactly where it was (so does
  Shift colour, which edits these curves). R/G/B curves are classic and do
  change brightness.
  This is the panel for "the shadows are too red". Shift colour on the image
  edits these curves too.
- The histogram of the current image sits behind the curves.
- **Smooth** relaxes the shown curve, like Rhino's Smooth. Click again for
  more. **Reset** or a double-click clears it.
- Dragging never places points: the change falls off smoothly around where you
  grab. Press right on the curve for a narrow change, further away from it
  for a broader one; the shaded bell, drawn along the curve, shows what will move. The background shows which
  colour each direction moves the image towards, and while you drag in the
  Colour panel a swatch shows the exact colour of the push. Curves are B-splines whose control points sit
  off the curve, like NURBS in Rhino, so they can't kink. The faint hairlines
  are a curvature comb: bumps there mean bumps in the tones.
- The x-axis is labelled in zones (I to IX).
- The **Light** curve changes brightness only: it adds the same amount to R,
  G and B, so colours keep their hue. The Light and Colour by tone curves both
  read a pixel's tone *before* the Light curve, so brightening or darkening
  something never moves it onto another part of the colour curves.

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

While you drag a slider, curve, levels handle or shift tool, the browser renders
the preview itself: it keeps a small 16-bit copy of the cropped input and, per
change, fetches only the per-channel stages as a 4096-entry table (`/api/lut`),
so the image follows the drag instantly. The full render replaces it when you
let go. Crop, rotation and colour noise still render on the server.

**Crossover.** The three dye layers of a colour film have slightly different
contrast, so after inversion the cast changes with brightness: neutral mids,
red shadows, cyan highlights. One white balance can't fix that. In the log
domain each channel needs only an offset and a slope. Solve does the
equivalent where you can see and change it: it bends the Colour by tone curves
(warmth and tint by brightness) by least squares through all your samples,
as smoothly and as little as it can. With one sample it reduces to a white
balance.

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
