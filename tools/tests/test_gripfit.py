"""Unit tests for the grip-model fit (design 4.9, P12.0).

Uses synthetic data throughout (no FastF1 dependency) so these run offline
and fast, same convention as test_centerline.py / test_geometry.py.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from gradient_circuit.centerline import DS, compute_tangent_normal, reparameterize_uniform
from gradient_circuit.geometry import compute_curvature
from gradient_circuit.gripfit import (
    CourseRef,
    fit_grip_curve,
    lateral_accel_samples,
    lateral_grip_at,
    project_clean_laps,
    speed_bin_envelope,
    tightest_corner_report,
)
from gradient_circuit.laps import CleanLap


# ---------------------------------------------------------------------------
# speed_bin_envelope
# ---------------------------------------------------------------------------


def test_speed_bin_envelope_bins_and_takes_percentile():
    # Bin 0 (0-10 m/s): a_lat values 1..40, p95 of that set. Bin 1 (10-20
    # m/s): only 5 points, below MIN_BIN_SAMPLES and must be dropped.
    v_bin0 = np.full(40, 5.0)
    a_bin0 = np.arange(1, 41, dtype=float)
    v_bin1 = np.full(5, 15.0)
    a_bin1 = np.array([100.0, 100.0, 100.0, 100.0, 100.0])
    samples = np.column_stack([
        np.concatenate([v_bin0, v_bin1]),
        np.concatenate([a_bin0, a_bin1]),
    ])

    v_mid, a_env, counts = speed_bin_envelope(samples, bin_width=10.0, min_samples=30, percentile=95)

    assert len(v_mid) == 1  # bin 1 dropped (only 5 samples < min_samples)
    assert v_mid[0] == pytest.approx(5.0)
    assert a_env[0] == pytest.approx(np.percentile(a_bin0, 95))
    assert counts[0] == 40


def test_speed_bin_envelope_empty_input():
    v_mid, a_env, counts = speed_bin_envelope(np.empty((0, 2)))
    assert len(v_mid) == 0 and len(a_env) == 0 and len(counts) == 0


# ---------------------------------------------------------------------------
# fit_grip_curve / lateral_grip_at
# ---------------------------------------------------------------------------


def test_fit_grip_curve_recovers_known_coefficients_with_saturation():
    """Construct an exact a0 + k*v^2 envelope up to a known saturation
    speed, then flat beyond it (no noise) -- the fit must recover a0/k from
    the rising part and a_cap from the plateau, per design 4.9 step 4-5."""
    a0_true, k_true = 21.0, 0.012
    v_sat = 60.0  # m/s -- speed at which the true curve saturates
    a_cap_true = a0_true + k_true * v_sat**2

    v_mid = np.arange(5.0, 90.0, 10.0)  # rising bins + several plateau bins
    a_true = np.minimum(a0_true + k_true * v_mid**2, a_cap_true)

    fit = fit_grip_curve(v_mid, a_true)

    assert fit.a0 == pytest.approx(a0_true, abs=0.5)
    assert fit.k == pytest.approx(k_true, rel=0.05)
    assert fit.a_cap == pytest.approx(a_cap_true, abs=0.5)


def test_fit_grip_curve_requires_at_least_two_bins():
    with pytest.raises(ValueError):
        fit_grip_curve(np.array([10.0]), np.array([25.0]))


def test_lateral_grip_at_saturates_above_cap():
    from gradient_circuit.gripfit import GripFit

    fit = GripFit(a0=20.0, k=0.01, a_cap=45.0, peak_bin_index=3)

    # Below saturation: matches the raw quadratic.
    v_low = 10.0
    assert lateral_grip_at(v_low, fit) == pytest.approx(fit.a0 + fit.k * v_low**2)

    # Far above: capped, not still rising.
    v_high = 200.0
    assert lateral_grip_at(v_high, fit) == pytest.approx(fit.a_cap)

    # Vectorized form works the same way.
    v_arr = np.array([v_low, v_high])
    out = lateral_grip_at(v_arr, fit)
    assert out[0] == pytest.approx(fit.a0 + fit.k * v_low**2)
    assert out[1] == pytest.approx(fit.a_cap)


# ---------------------------------------------------------------------------
# project_clean_laps / lateral_accel_samples / tightest_corner_report
# (end-to-end on a synthetic circular course, constant known curvature)
# ---------------------------------------------------------------------------


def _make_circle_course(radius: float, n_raw: int = 3000) -> CourseRef:
    theta = np.linspace(0, 2 * np.pi, n_raw, endpoint=False)
    xyz_raw = np.column_stack([radius * np.cos(theta), radius * np.sin(theta), np.zeros(n_raw)])
    ref_s, ref_xyz = reparameterize_uniform(xyz_raw, DS)
    _, ref_normal = compute_tangent_normal(ref_xyz, closed=True)
    curvature = compute_curvature(ref_xyz)
    return CourseRef(
        id="test-circle", ref_s=ref_s, ref_xyz=ref_xyz, ref_normal=ref_normal,
        curvature=curvature, length=float(ref_s[-1] + DS),
    )


def _lap_at_constant_speed(course: CourseRef, speed_mps: float) -> CleanLap:
    """A synthetic clean lap tracing the course's own reference line at a
    constant real speed -- lets a_lat be predicted exactly (v^2/radius) and
    checked against what project_clean_laps + lateral_accel_samples derive
    from telemetry alone."""
    xyz = course.ref_xyz
    dist = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(xyz, axis=0), axis=1))])
    telemetry = pd.DataFrame({
        "X": xyz[:, 0], "Y": xyz[:, 1], "Z": xyz[:, 2], "Distance": dist,
        "Speed": np.full(len(xyz), speed_mps * 3.6),  # km/h, as the real FastF1 channel is
    })
    return CleanLap(driver="TST", lap_number=1.0, lap_time_s=100.0, telemetry=telemetry)


def test_lateral_accel_samples_matches_v_squared_over_radius():
    radius = 100.0
    course = _make_circle_course(radius)
    speed_mps = 40.0
    lap = _lap_at_constant_speed(course, speed_mps)

    points = project_clean_laps([lap], scale=1.0, course=course)
    n = len(course.ref_s)
    assert len(points.speed_mps) > 0.9 * n  # nearly every reference sample hit

    samples = lateral_accel_samples(points, course)
    expected_a_lat = speed_mps**2 / radius
    assert samples[:, 0] == pytest.approx(speed_mps, abs=1e-6)

    # Exclude the closed-loop wrap seam (anchor 0 and n-1): the reparameterized
    # grid guarantees the closing gap lands in [0, DS), not exactly DS (see
    # centerline._sample_count_for_closed_loop's docstring), so the fixed-DS
    # finite-difference curvature at exactly that seam has more error than
    # the interior -- a known, pre-existing property of the sample grid
    # (test_geometry.py excludes the same kind of wrap-around samples), not
    # something gripfit.py introduces.
    interior = (points.anchor_i != 0) & (points.anchor_i != n - 1)
    assert interior.sum() > 0.9 * len(points.anchor_i)
    assert samples[interior, 1] == pytest.approx(expected_a_lat, rel=0.01)


def test_tightest_corner_report_ratio_near_one_when_real_matches_model():
    """A lap driven at exactly the fitted model's speed limit for the
    course's (constant) curvature should report ratio_p50 ~= 1.0."""
    radius = 50.0
    course = _make_circle_course(radius)

    from gradient_circuit.gripfit import GripFit

    fit = GripFit(a0=20.0, k=0.01, a_cap=60.0, peak_bin_index=0)
    kappa = 1.0 / radius
    # Solve v such that lateral_grip_at(v, fit) == v^2 * kappa (self-consistent limit speed).
    # For the unsaturated branch: v^2*kappa = a0 + k*v^2 -> v^2 = a0/(kappa-k)
    assert kappa > fit.k, "test radius must stay below saturation for this closed-form solution"
    v_limit = float(np.sqrt(fit.a0 / (kappa - fit.k)))
    # ... and that solution must itself land below a_cap, or fit.k wasn't
    # actually the active constraint at v_limit (radius chosen too large).
    assert fit.a0 + fit.k * v_limit**2 <= fit.a_cap

    lap = _lap_at_constant_speed(course, v_limit)
    points = project_clean_laps([lap], scale=1.0, course=course)

    report = tightest_corner_report(points, course, fit, top_fraction=1.0)
    assert report is not None
    assert report.ratio_p50 == pytest.approx(1.0, rel=0.02)
