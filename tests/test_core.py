import numpy as np

from filmneg import analysis, curves, imageio, pipeline
from filmneg.color import ADOBE_RGB


def grey_ramp(n=9):
    v = np.linspace(0.15, 0.85, n, dtype=np.float32)
    return np.stack([v, v, v], axis=1)


def test_defaults_are_identity_below_the_shoulder():
    rgb = grey_ramp() * 0.9
    out = pipeline.render_pixels(rgb, pipeline.default_params(), ADOBE_RGB)
    lin_in = ADOBE_RGB.decode(rgb)
    keep = lin_in < 0.8  # above the knee highlights are rolled off on purpose
    assert np.allclose(out[keep], rgb[keep], atol=1e-4)


def test_lut_path_matches_direct_path():
    rng = np.random.default_rng(0)
    img = rng.random((600, 500, 3), dtype=np.float32)
    p = pipeline.default_params()
    p.update(slope=[1.1, 1.0, 0.9], offset=[0.1, 0.0, -0.2], exposure=0.3, contrast=1.2)
    p["curves"]["r"] = list(curves.bump(0.3, 0.02))
    p["curves"]["warmth"] = list(curves.bump(0.6, 0.02))
    big = pipeline.render_pixels(img, p, ADOBE_RGB)
    small = pipeline.render_pixels(img[:10, :10], p, ADOBE_RGB)
    assert np.abs(big[:10, :10] - small).max() < 2e-4


def test_light_by_range_and_old_sidecars():
    p = pipeline.normalize({"lighting": "golden hour"})
    assert p["light"]["warmth"] == 1.0 and "lighting" not in p
    p["light"]["highlights"] = [1.0, 0.0]
    assert analysis.target(p, 0.9)[1] > analysis.target(p, 0.3)[1] + 0.015


def test_tiff_roundtrip_keeps_profile(tmp_path):
    rgb = np.random.default_rng(2).random((20, 30, 3), dtype=np.float32)
    icc = b"\x00" * 128  # contents don't matter for the roundtrip
    path = tmp_path / "x.tif"
    imageio.save_tiff16(path, rgb, icc)
    scan = imageio.load(path)
    assert scan.icc == icc
    assert np.abs(scan.rgb - rgb).max() < 1 / 65535 + 1e-6


def test_auto_crop_finds_frame():
    img = np.ones((100, 120, 3), np.float32)       # white scanner surround
    img[10:90, 15:110] = 0.0                       # black film rebate
    img[14:86, 20:104] = 0.5                       # the picture
    x0, y0, x1, y1 = analysis.auto_crop(img)
    assert 0.16 < x0 < 0.22 and 0.13 < y0 < 0.2 and 0.84 < x1 < 0.87 and 0.82 < y1 < 0.86


def test_levels_set_black_and_white_points():
    p = pipeline.default_params()
    p["levels"]["rgb"].update(lo=0.1, hi=0.6)
    rgb = np.array([[0.1, 0.35, 0.6]] * 3, np.float32).T.copy()  # three greys
    out = pipeline.render_pixels(rgb, p, ADOBE_RGB)
    assert out[0, 0] < 0.01 and out[2, 0] > 0.99


def test_levels_gamma_output_and_channels():
    x = np.float32(0.25)
    assert abs(pipeline.apply_level(x, {**pipeline.IDENTITY_LEVEL, "gamma": 2.0}) - 0.5) < 1e-6
    assert abs(pipeline.apply_level(np.float32(1), {**pipeline.IDENTITY_LEVEL, "out_hi": 0.9}) - 0.9) < 1e-6
    p = pipeline.default_params()
    p["levels"]["b"].update(hi=0.8)                # only blue gets brighter
    out = pipeline.render_pixels(np.full((1, 3), 0.4, np.float32), p, ADOBE_RGB)
    assert out[0, 2] > out[0, 1] + 0.05 and abs(out[0, 0] - out[0, 1]) < 1e-6


def test_old_sidecar_levels_still_load():
    p = pipeline.normalize({"levels": {"lo": [0.1, 0.0, 0.0], "hi": [1.0, 0.9, 1.0]}})
    assert p["levels"]["r"]["lo"] == 0.1 and p["levels"]["g"]["hi"] == 0.9 and p["levels"]["rgb"]["gamma"] == 1.0


def test_area_sample_ignores_dust():
    img = np.full((101, 101, 3), 0.5, np.float32)
    img[48:53, 48:53] = 1.0                        # a dust speck in the middle
    area = analysis.sample_color(img, {"x": 0.5, "y": 0.5, "r": 0.3})
    assert abs(area[0] - 0.5) < 0.01
    assert analysis.sample_color(img, {"x": 0.2, "y": 0.2, "r": 0})[0] == 0.5


def test_cast_report_names_a_warm_highlight_cast():
    v = np.linspace(0.05, 0.95, 64, dtype=np.float32)
    img = np.stack([v, v, v], axis=-1)[None].repeat(64, axis=0)
    img[..., :, 2] -= np.where(v > 0.7, 0.06, 0.0)   # yellow highlights only
    out = pipeline.render_pixels(img, pipeline.default_params(), ADOBE_RGB)
    rep = analysis.cast_report(out, [], [], [], pipeline.default_params(), ADOBE_RGB)
    bands = {l["band"]: l["text"] for l in rep["lines"]}
    assert bands["Shadows"] == "neutral" and "yellow" in bands["Highlights"]
    assert "changes with brightness" in rep["summary"]


def test_roll_off_sliders():
    p = pipeline.default_params()
    x = np.array([[0.02] * 3, [0.46] * 3, [0.97] * 3], np.float32)
    base = pipeline.render_pixels(x, p, ADOBE_RGB)
    soft = pipeline.render_pixels(x, {**p, "shoulder": 1.0, "toe": 1.0}, ADOBE_RGB)
    assert soft[2, 0] < base[2, 0] - 0.01      # highlights roll off earlier
    assert soft[0, 0] < base[0, 0] - 0.01      # deep shadows ease towards black
    assert abs(soft[1, 0] - base[1, 0]) < 0.02  # mid grey barely moves


def test_rotate_keeps_size_and_centre():
    img = np.zeros((41, 61, 3), np.float32)
    img[20, :, :] = 1.0                            # a horizontal line through the centre
    out = pipeline.rotate(img, 10)
    assert out.shape == img.shape and out[20, 30, 0] > 0.5 and out[20, 5, 0] < 0.5


def test_distortion_straightens_a_bowed_line():
    img = np.zeros((101, 101, 3), np.float32)
    xs = np.arange(101)
    ys = np.rint(80 - 0.0024 * (xs - 50) ** 2).astype(int)   # barrel: the middle bulges outwards
    img[np.clip(ys, 0, 100), xs] = 1.0
    def bow(im):
        rows = [np.argmax(im[:, x, 0]) for x in (10, 50, 90)]
        return (rows[0] + rows[2]) / 2 - rows[1]
    assert abs(bow(pipeline.geometry(img, 0, 10))) < abs(bow(img)) <= abs(bow(pipeline.geometry(img, 0, -10)))


def test_dust_found_and_healed():
    from filmneg import dust
    rng = np.random.default_rng(0)
    clean = np.clip(0.5 + rng.normal(0, 0.01, (400, 500, 3)), 0, 1).astype(np.float32)
    img = clean.copy()
    yy, xx = np.ogrid[:400, :500]
    for cy, cx in [(100, 120), (250, 300), (330, 80)]:
        img[(yy - cy) ** 2 + (xx - cx) ** 2 <= 9] += 0.3       # specks
    img[200:202, 50:150] += 0.3                                  # a hair
    spots = dust.find(img)
    sure = [s for s in spots if s["conf"] > 0.6]
    assert len(sure) == 4 and any(s["kind"] == "hair" for s in sure)
    out = dust.heal(img, sure, spots)
    assert np.abs(out - clean).max() < 0.08
    assert np.abs(img - clean).max() > 0.25


def test_geometry_point_round_trip():
    u, v = pipeline.geometry_point(0.7, 0.2, 400, 300, 7, 3)
    assert np.allclose(pipeline.geometry_point(u, v, 400, 300, 7, 3, inverse=True), (0.7, 0.2))


def test_dust_learning_moves_similar_spots():
    from filmneg import dust
    a = {"id": 1, "base": 1.0, "f": [1.0, 0, 0, 0, 0, 0, 0.5], "conf": 0.73}
    twin = {"id": 2, "base": 1.0, "f": [1.0, 0, 0, 0, 0, 0, 0.5], "conf": 0.73}
    other = {"id": 3, "base": 1.0, "f": [-1.0, 0, 0, 1, 0, 1, 0.5], "conf": 0.73}
    a["on"] = False
    rejected = [dict(a, id=10 + i) for i in range(3)]  # three of a kind rejected
    dust.relearn(rejected + [twin, other])
    assert twin["conf"] < 0.6 and other["conf"] > twin["conf"]


def test_clone_stroke_copies_from_source():
    from filmneg import dust
    img = np.zeros((200, 200, 3), np.float32)
    img[:, 100:] = 1.0
    s = dust.clone_spot([(0.25, 0.5)], 0.03, (0.5, 0.0), 200, 200)
    s["id"] = 1
    out = dust.heal(img, [s])
    assert out[100, 50].mean() > 0.95 and out[20, 50].mean() == 0


def test_colour_by_tone_keeps_brightness():
    from filmneg.color import luma
    rgb = grey_ramp() * 0.8
    p = pipeline.default_params()
    p["curves"]["tint"] = list(curves.bump(0.5, 0.05, 0.3))
    p["curves"]["warmth"] = list(curves.bump(0.5, 0.05, 0.3))
    out = pipeline.render_pixels(rgb, p, ADOBE_RGB)
    base = pipeline.render_pixels(rgb, pipeline.default_params(), ADOBE_RGB)
    assert np.allclose(luma(out), luma(base), atol=2e-3)
    assert np.abs(out - base).max() > 0.01


def test_dust_decisions_update_source_locally(tmp_path):
    # switching single repairs patches the cached source around those spots only;
    # the result must equal a full re-render, also rotated and with colour noise
    from filmneg import dust, server
    rng = np.random.default_rng(0)
    img = np.clip(0.5 + rng.normal(0, 0.01, (400, 500, 3)), 0, 1).astype(np.float32)
    yy, xx = np.ogrid[:400, :500]
    for cy, cx in [(100, 120), (250, 300), (330, 80), (60, 400)]:
        img[(yy - cy) ** 2 + (xx - cx) ** 2 <= 9] += 0.3
    imageio.save_tiff16(tmp_path / "x.tif", img, b"\x00" * 128)
    s = server.Session(tmp_path)
    s.load("x.tif")
    s.dust["spots"] = dust.find(s.scan.rgb)
    s.dust_changed(new_spots=True)
    for geo in [(0, 0), (1.1, 1.5)]:
        p = pipeline.normalize({"angle": geo[0], "distortion": geo[1], "nr": 0.5})
        before = s.source("full", p).copy()
        s.dust["spots"][0]["on"] = False
        quick = s.source("full", p).copy()
        s._nr_cache = {}
        assert np.abs(quick - s.source("full", p)).max() < 1e-6
        assert np.abs(quick - before).max() > 0.1
        s.dust["spots"][0]["on"] = None


def test_neutralize_a_measured_point():
    # the full correction makes the spot neutral; it only bends the curves near its tone
    col = np.array([0.55, 0.5, 0.42], np.float32)
    p = pipeline.default_params()
    r = analysis.neutralize(col, "neutral", p, ADOBE_RGB, sigma=0.12)
    fix = lambda d: {**p, "curves": {**p["curves"], "warmth": d["warmth"], "tint": d["tint"]}}
    rep = analysis.sample_report(col[None], ["neutral"], fix(r["full"]), ADOBE_RGB)[0]
    assert np.hypot(rep["da"], rep["db"]) < 1
    # yellow/blue alone: b goes, a stays where it was
    before = analysis.sample_report(col[None], ["neutral"], p, ADOBE_RGB)[0]
    rep = analysis.sample_report(col[None], ["neutral"], fix(r["b"]), ADOBE_RGB)[0]
    assert abs(rep["db"]) < 1 and abs(rep["da"] - before["da"]) < 1
    w = np.abs(r["full"]["warmth"])
    assert w[0] < 0.2 * w.max() and w[-1] < 0.2 * w.max()


def test_light_curve_moves_brightness_only():
    # the same amount goes onto R, G and B, so coloured pixels keep their colour
    # differences: brightening or darkening never shifts hues
    cols = np.array([[0.5, 0.3, 0.2], [0.2, 0.4, 0.6], [0.4, 0.4, 0.4]], np.float32)
    p0 = pipeline.default_params()
    p = pipeline.default_params()
    p["curves"]["lightness"] = list(0.08 * np.asarray(curves.bump(0.4, 0.2)))
    a, b = pipeline.render_pixels(cols, p0, ADOBE_RGB), pipeline.render_pixels(cols, p, ADOBE_RGB)
    assert np.allclose(np.diff(a, axis=1), np.diff(b, axis=1), atol=2e-3)
    assert np.all(b.mean(axis=1) > a.mean(axis=1) + 0.01)


def test_preview_jpeg_is_srgb():
    # the preview goes out already in sRGB (tagged), so every browser shows it right
    import io
    from PIL import Image, ImageCms
    adobe = np.array([[[0.5, 0.35, 0.2]]], np.float32)
    im = Image.open(io.BytesIO(imageio.to_jpeg(adobe, ADOBE_RGB)))
    assert "sRGB" in ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(im.info["icc_profile"])))
    want = imageio.to_srgb(adobe, ADOBE_RGB)[0, 0] * 255
    assert np.abs(np.asarray(im)[0, 0] - want).max() < 3


def test_levels_eyedroppers():
    p = pipeline.default_params()
    grey = np.array([0.5, 0.45, 0.38], np.float32)
    q = analysis.levels_eyedrop(grey, "neutral", p, ADOBE_RGB)
    out = pipeline.render_pixels(grey[None], q, ADOBE_RGB)[0]
    assert np.ptp(out) < 0.01 and q["levels"]["g"] == p["levels"]["g"]  # green keeps the brightness
    white = np.array([0.9, 0.85, 0.78], np.float32)
    q = analysis.levels_eyedrop(white, "white", q, ADOBE_RGB)
    out = pipeline.render_pixels(white[None], q, ADOBE_RGB)[0]
    assert np.ptp(out) < 0.01 and abs(out.mean() - 245 / 255) < 0.01
    # with a warm light, grey keeps a little warmth
    p["light"]["warmth"] = 1.0
    q = analysis.levels_eyedrop(grey, "neutral", p, ADOBE_RGB)
    out = pipeline.render_pixels(grey[None], q, ADOBE_RGB)[0]
    assert out[0] > out[2] + 0.02


def test_points_neutral_follows_the_light():
    # with a warm Light, "neutral" for a point is the light's warmth: Correct just
    # here's full correction leaves the spot warm, by as much as the light says
    col = np.array([0.55, 0.5, 0.42], np.float32)
    p = pipeline.default_params()
    p["light"]["warmth"] = 1.0
    r = analysis.neutralize(col, "neutral", p, ADOBE_RGB, sigma=0.12)
    q = {**p, "curves": {**p["curves"], "warmth": r["full"]["warmth"], "tint": r["full"]["tint"]}}
    neutral = {**q, "light": pipeline.default_params()["light"]}
    rep = analysis.sample_report(col[None], ["neutral"], neutral, ADOBE_RGB)[0]
    assert rep["db"] > 10  # warm on purpose
    rep = analysis.sample_report(col[None], ["neutral"], q, ADOBE_RGB)[0]
    assert np.hypot(rep["da"], rep["db"]) < 1  # and right on the light's colour


def test_eyedropper_drag_leaves_a_cast():
    # dragging the eyedropper towards yellow leaves the spot that much yellow
    p = pipeline.default_params()
    for kind, col in (("white", [0.9, 0.85, 0.78]), ("black", [0.12, 0.1, 0.14]), ("neutral", [0.5, 0.45, 0.38])):
        col = np.array(col, np.float32)
        q = analysis.levels_eyedrop(col, kind, p, ADOBE_RGB, cast=(10, 0))
        out = pipeline.render_pixels(col[None], q, ADOBE_RGB)[0] * 255
        assert 7 < out[0] - out[2] < 13, (kind, out)
        q = analysis.levels_eyedrop(col, kind, p, ADOBE_RGB, cast=(0, 10))
        out = pipeline.render_pixels(col[None], q, ADOBE_RGB)[0] * 255
        assert out[1] < min(out[0], out[2]) - 4, (kind, out)  # magenta: less green


def test_export_never_overwrites(tmp_path):
    from filmneg.server import export_path
    scan = tmp_path / "frame 03 #2.tif"
    assert export_path(scan).name == "frame 03 #2_filmneg.tif"
    export_path(scan).write_bytes(b"x")
    assert export_path(scan).name == "frame 03 #2_filmneg-2.tif"
    export_path(scan).write_bytes(b"x")
    assert export_path(scan).name == "frame 03 #2_filmneg-3.tif"


def test_preview_jpeg_in_display_p3():
    # wide-gamut preview: tagged Display P3, and lcms reads it back to the same colour
    import io
    from PIL import Image, ImageCms
    from filmneg.color import DISPLAY_P3
    adobe = np.array([[[0.3, 0.7, 0.25]]], np.float32)  # a strong green, beyond sRGB
    im = Image.open(io.BytesIO(imageio.to_jpeg(adobe, ADOBE_RGB, display="p3")))
    prof = ImageCms.ImageCmsProfile(io.BytesIO(im.info["icc_profile"]))
    assert "Display P3" in ImageCms.getProfileDescription(prof)
    want = imageio.to_display(adobe, ADOBE_RGB, DISPLAY_P3)[0, 0] * 255
    assert np.abs(np.asarray(im)[0, 0] - want).max() < 3
    assert imageio.to_srgb(adobe, ADOBE_RGB)[0, 0, 0] == 0  # sRGB had to clip it
    lab = ImageCms.buildTransform(prof, ImageCms.createProfile("LAB"), "RGB", "LAB")
    srgb_lab = ImageCms.buildTransform(ImageCms.createProfile("sRGB"), ImageCms.createProfile("LAB"), "RGB", "LAB")
    g = Image.new("RGB", (1, 1), tuple(int(v) for v in np.round(want)))
    assert ImageCms.applyTransform(g, lab).getpixel((0, 0)) != ImageCms.applyTransform(g, srgb_lab).getpixel((0, 0))


def test_export_turns_by_quarters(tmp_path):
    from filmneg import server
    img = np.clip(0.4 + np.random.default_rng(1).normal(0, 0.05, (200, 300, 3)), 0, 1).astype(np.float32)
    img[:40, :40] = 0.95  # a bright top-left corner
    imageio.save_tiff16(tmp_path / "x.tif", img, b"\x00" * 128)
    s = server.Session(tmp_path)
    s.load("x.tif")
    p = pipeline.default_params() | {"crop": [0, 0, 1, 1], "quarter": 1}
    import tifffile
    out = tifffile.imread(s.export(p))
    assert out.shape[:2] == (300, 200)          # portrait now
    assert out[:30, -30:].mean() > out[-30:, :30].mean() + 10000  # top-left went to top-right (clockwise)


def test_export_jpeg_is_full_size_srgb(tmp_path):
    import io
    from PIL import Image, ImageCms
    from filmneg import server
    img = np.clip(0.4 + np.random.default_rng(2).normal(0, 0.05, (200, 300, 3)), 0, 1).astype(np.float32)
    imageio.save_tiff16(tmp_path / "x.tif", img, b"\x00" * 128)
    s = server.Session(tmp_path)
    s.load("x.tif")
    p = pipeline.default_params() | {"crop": [0, 0, 1, 1]}
    a, b = s.export(p, "jpeg"), s.export(p, "jpeg")
    assert a.endswith("x_filmneg.jpg") and b.endswith("x_filmneg-2.jpg")
    im = Image.open(a)
    assert im.size == (300, 200)
    assert "sRGB" in ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(im.info["icc_profile"])))


def test_file_menu_lists_subfolders(tmp_path):
    from filmneg import server
    img = np.full((20, 30, 3), 0.5, np.float32)
    for rel in ("a.tif", "roll 12/b.tif", "roll 12/b_filmneg.tif", ".hidden/c.tif", "roll 12/x/y/z/deep.tif"):
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        imageio.save_tiff16(tmp_path / rel, img, b"\\x00" * 128)
    assert server.Session(tmp_path).files() == ["a.tif", "roll 12/b.tif"]
