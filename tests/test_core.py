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


def test_solver_removes_crossover():
    """A cast that changes with brightness is fixed from greys at different tones."""
    truth = pipeline.default_params()
    truth.update(slope=[1.08, 1.0, 0.9], offset=[0.15, 0.0, -0.25])
    greys = grey_ramp(3)
    # Find the scan values that the "true" correction would turn into these greys,
    # by inverting the per-channel log transform.
    log = np.log2(ADOBE_RGB.decode(greys))
    s, o = np.array(truth["slope"]), np.array(truth["offset"])
    scan = ADOBE_RGB.encode(np.exp2((log - pipeline.PIVOT - o) / s + pipeline.PIVOT)).astype(np.float32)

    p0 = pipeline.default_params()
    before = analysis.sample_report(scan, ["neutral"] * 3, p0, ADOBE_RGB)
    p1 = analysis.solve(scan, ["neutral"] * 3, p0, ADOBE_RGB)
    after = analysis.sample_report(scan, ["neutral"] * 3, p1, ADOBE_RGB)

    worst = lambda rep: max(np.hypot(r["da"], r["db"]) for r in rep)
    assert worst(before) > 10
    assert worst(after) < 1.5
    assert abs(p1["slope"][2] - 0.9) < 0.05


def test_single_sample_is_a_white_balance():
    scan = np.array([[0.6, 0.55, 0.45]], np.float32)
    p = analysis.solve(scan, ["neutral"], pipeline.default_params(), ADOBE_RGB)
    assert abs(p["slope"][0] - 1) < 0.05 and abs(p["slope"][2] - 1) < 0.05
    rep = analysis.sample_report(scan, ["neutral"], p, ADOBE_RGB)[0]
    assert np.hypot(rep["da"], rep["db"]) < 1


def test_lighting_keeps_warmth():
    scan = np.array([[0.6, 0.6, 0.6]], np.float32)
    p = pipeline.default_params()
    p["lighting"] = "golden hour"
    p = analysis.solve(scan, ["neutral"], p, ADOBE_RGB)
    rep = analysis.sample_report(scan, ["neutral"], {**p, "lighting": "neutral"}, ADOBE_RGB)[0]
    assert rep["db"] > 10  # the grey is left warm on purpose


def test_straighten_flattens_a_tone_dependent_cast():
    rng = np.random.default_rng(1)
    t = rng.random((200, 200, 1), dtype=np.float32) * 0.8 + 0.1
    img = np.concatenate([t + 0.04 * (1 - t), t, t - 0.06 * (1 - t)], axis=-1)  # warm shadows
    p = pipeline.default_params()
    before = analysis.cast_by_tone(pipeline.render_pixels(img, p, ADOBE_RGB), ADOBE_RGB, max_chroma=0.08)
    p2 = analysis.straighten(img, p, ADOBE_RGB, keep_overall=False)
    after = analysis.cast_by_tone(pipeline.render_pixels(img, p2, ADOBE_RGB), ADOBE_RGB, max_chroma=0.08)
    err = lambda bands: np.mean([np.hypot(a, b) for a, b, c in bands if c])
    assert err(after) < 0.5 * err(before)

    # keep_overall: the cast becomes even across tones but its average stays
    p3 = analysis.straighten(img, p, ADOBE_RGB, keep_overall=True)
    kept = analysis.cast_by_tone(pipeline.render_pixels(img, p3, ADOBE_RGB), ADOBE_RGB, max_chroma=0.08)
    spread = lambda bands: np.std([b for a, b, c in bands if c])
    mean_b = lambda bands: np.mean([b for a, b, c in bands if c])
    assert spread(kept) < 0.6 * spread(before)
    assert mean_b(kept) > 0.5 * mean_b(before)

    # strength 0 changes nothing
    p4 = analysis.straighten(img, p, ADOBE_RGB, strength=0.0)
    assert not np.any(p4["curves"]["warmth"])


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
