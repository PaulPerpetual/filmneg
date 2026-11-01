"""Smooth correction curves.

A curve is a list of N control values (deltas, default 0) for a clamped cubic
B-spline over the tone axis 0..1. Like a NURBS curve in Rhino, the control
points pull the curve without it passing through them, so it stays smooth
however the values are pushed around. The web UI evaluates the same spline.
"""
import numpy as np
from scipy.interpolate import BSpline

N_CTRL = 13
DEGREE = 3
_LUT_SIZE = 1024

CURVE_NAMES = ("lightness", "warmth", "tint", "r", "g", "b")


def knots(n=N_CTRL, k=DEGREE):
    interior = np.linspace(0.0, 1.0, n - k + 1)[1:-1]
    return np.concatenate([np.zeros(k + 1), interior, np.ones(k + 1)])


def ctrl_positions(n=N_CTRL, k=DEGREE):
    """Greville abscissae: where each control value 'sits' on the tone axis."""
    t = knots(n, k)
    return np.array([t[i + 1:i + k + 1].mean() for i in range(n)])


def zero_curve():
    return [0.0] * N_CTRL


def lut(ctrl):
    ctrl = np.asarray(ctrl, dtype=float)
    x = np.linspace(0.0, 1.0, _LUT_SIZE)
    return BSpline(knots(len(ctrl)), ctrl, DEGREE)(x)


def apply(ctrl, x):
    """Evaluate the curve (as a delta) at tone positions x in 0..1."""
    if not np.any(ctrl):
        return np.zeros_like(x)
    table = lut(ctrl)
    return np.interp(x, np.linspace(0.0, 1.0, len(table)), table).astype(x.dtype)


def bump(center, amount, sigma=0.15, n=N_CTRL):
    """Control deltas for a gentle Gaussian push centred at a tone position."""
    pos = ctrl_positions(n)
    return amount * np.exp(-0.5 * ((pos - center) / sigma) ** 2)
