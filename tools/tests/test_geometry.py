"""Unit tests for curvature/grade computation and the sign convention.

Uses a synthetic circle (no FastF1 dependency) so these run offline and fast.
"""

from __future__ import annotations

import numpy as np
import pytest

from gradient_circuit.geometry import compute_curvature, compute_grade
from gradient_circuit.centerline import DS


def _make_circle(radius: float, ccw: bool, n: int = 400, z: float = 0.0) -> np.ndarray:
    """A closed circle of the given radius, sampled at ~1 point/degree,
    traversed counter-clockwise if ccw else clockwise, in the XY plane."""
    theta = np.linspace(0, 2 * np.pi, n, endpoint=False)
    if not ccw:
        theta = -theta
    x = radius * np.cos(theta)
    y = radius * np.sin(theta)
    zc = np.full(n, z)
    return np.column_stack([x, y, zc])


def test_curvature_sign_matches_left_turn_convention():
    """A CCW circle (left turns throughout, under our +90deg-rotation
    convention) must show positive curvature everywhere; CW must be
    negative. Magnitude should match 1/radius."""
    radius = 50.0
    ccw = _make_circle(radius, ccw=True, n=720)
    cw = _make_circle(radius, ccw=False, n=720)

    k_ccw = compute_curvature(ccw)
    k_cw = compute_curvature(cw)

    # ignore the wrap-around samples where central differences are less exact
    interior = slice(5, -5)
    assert np.all(k_ccw[interior] > 0)
    assert np.all(k_cw[interior] < 0)
    assert np.median(np.abs(k_ccw[interior])) == pytest.approx(1.0 / radius, rel=0.05)
    assert np.median(np.abs(k_cw[interior])) == pytest.approx(1.0 / radius, rel=0.05)


def test_total_signed_turn_over_closed_loop_is_360_degrees():
    """Regression guard for the whole-lap sign-convention check used in
    design 4.6: sum(curvature) * ds over one closed loop must be +-360 deg,
    positive for CCW, negative for CW."""
    radius = 80.0
    n = 1000
    ccw = _make_circle(radius, ccw=True, n=n)
    cw = _make_circle(radius, ccw=False, n=n)

    # ds for this synthetic circle (arc length per sample)
    ds = 2 * np.pi * radius / n

    k_ccw = compute_curvature(ccw)
    k_cw = compute_curvature(cw)

    assert np.degrees(np.sum(k_ccw) * ds) == pytest.approx(360.0, abs=2.0)
    assert np.degrees(np.sum(k_cw) * ds) == pytest.approx(-360.0, abs=2.0)


def test_grade_matches_known_slope():
    """A straight ramp climbing at a known angle should report that grade."""
    n = 200
    ds = 1.0
    angle = np.radians(5.0)  # 5 degree uphill grade
    s = np.arange(n) * ds
    x = s * np.cos(angle)
    y = np.zeros(n)
    z = s * np.sin(angle)
    xyz = np.column_stack([x, y, z])

    grade = compute_grade(xyz)
    interior = slice(5, -5)
    assert np.median(grade[interior]) == pytest.approx(angle, abs=0.01)
