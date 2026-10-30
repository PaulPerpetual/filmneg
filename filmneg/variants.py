"""The Galapagos-like variant grid ("ring-around").

The current image sits in the centre of a 3x3 grid. The eight neighbours are
four meaningful directions, each pushed both ways, so opposite cells are
opposites. Picking a cell makes it the new centre. Step sizes shrink when you
keep the centre and grow when you keep going the same way, and directions
you pick get offered more often.
"""
import copy
import random

from . import curves

# name: (label for +, label for -, how to apply one step)
AXES = {
    "exposure": ("brighter", "darker"),
    "contrast": ("more contrast", "less contrast"),
    "saturation": ("more colour", "less colour"),
    "warm_shadows": ("warmer shadows", "cooler shadows"),
    "warm_mids": ("warmer mids", "cooler mids"),
    "warm_highlights": ("warmer highlights", "cooler highlights"),
    "tint_shadows": ("more magenta in shadows", "more green in shadows"),
    "tint_mids": ("more magenta in mids", "more green in mids"),
    "tint_highlights": ("more magenta in highlights", "more green in highlights"),
}

_TONE = {"shadows": 0.2, "mids": 0.5, "highlights": 0.8}
_STEP = {"exposure": 0.12, "contrast": 0.05, "saturation": 0.07, "warm": 0.015, "tint": 0.012}

# Grid cells (row-major, 4 is the centre); each pair holds opposite cells.
_PAIRS = [(1, 7), (3, 5), (0, 8), (2, 6)]


def new_state():
    return {"step": 1.0, "weights": {k: 1.0 for k in AXES}, "last": None, "generation": 0}


def apply_step(params, axis, sign, step):
    p = copy.deepcopy(params)
    if axis == "exposure":
        p["exposure"] += sign * _STEP["exposure"] * step
    elif axis == "contrast":
        p["contrast"] *= 1 + sign * _STEP["contrast"] * step
    elif axis == "saturation":
        p["saturation"] *= 1 + sign * _STEP["saturation"] * step
    else:
        kind, tone = axis.split("_")
        name = "warmth" if kind == "warm" else "tint"
        delta = curves.bump(_TONE[tone], sign * _STEP[kind] * step, sigma=0.17)
        p["curves"][name] = [float(a + b) for a, b in zip(p["curves"][name], delta)]
    return p


def generate(params, state, seed=None):
    """Return 9 cells: dicts with params, label, axis and sign (centre has axis None)."""
    rng = random.Random(seed)
    names = list(AXES)
    chosen = []
    pool = dict(state["weights"])
    if state.get("last") and state["last"][0] in pool:
        chosen.append(state["last"][0])  # keep offering the direction you just took
        pool.pop(state["last"][0])
    while len(chosen) < 4:
        total = sum(pool.values())
        r, acc = rng.uniform(0, total), 0.0
        for name in names:
            if name not in pool:
                continue
            acc += pool[name]
            if acc >= r:
                chosen.append(name)
                pool.pop(name)
                break

    cells = [None] * 9
    cells[4] = {"params": copy.deepcopy(params), "label": "current", "axis": None, "sign": 0}
    for axis, (plus, minus) in zip(chosen, _PAIRS):
        for sign, idx in ((1, plus), (-1, minus)):
            cells[idx] = {
                "params": apply_step(params, axis, sign, state["step"]),
                "label": AXES[axis][0 if sign > 0 else 1],
                "axis": axis,
                "sign": sign,
            }
    return cells


def pick(state, cells, index):
    """Update the search state after the user picked cell `index`."""
    s = copy.deepcopy(state)
    s["generation"] += 1
    cell = cells[index]
    offered = {c["axis"] for c in cells if c["axis"]}
    if cell["axis"] is None:
        s["step"] = max(0.15, s["step"] * 0.6)  # nothing better: look closer
        s["last"] = None
    else:
        same = s["last"] == [cell["axis"], cell["sign"]]
        s["step"] = min(3.0, s["step"] * (1.3 if same else 0.85))
        s["last"] = [cell["axis"], cell["sign"]]
    for axis in offered:
        if axis == cell["axis"]:
            s["weights"][axis] = min(4.0, s["weights"][axis] + 0.6)
        else:
            s["weights"][axis] = max(0.25, s["weights"][axis] * 0.85)
    return s
