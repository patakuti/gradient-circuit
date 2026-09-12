"""Unit tests for reference speed profile extraction (design 4.8, P15.1).

Synthetic data throughout (no FastF1 dependency), same convention as
test_centerline.py / test_gripfit.py.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from gradient_circuit.centerline import DS, compute_tangent_normal, reparameterize_uniform
from gradient_circuit.gripfit import GripFit
from gradient_circuit.laps import CleanLap
from gradient_circuit.reference import extract_reference_speed, reachability_violation_fraction


def _make_circle_reference(radius: float = 200.0, n_raw: int = 3000):
    theta = np.linspace(0, 2 * np.pi, n_raw, endpoint=False)
    xyz_raw = np.column_stack([radius * np.cos(theta), radius * np.sin(theta), np.zeros(n_raw)])
    ref_s, ref_xyz = reparameterize_uniform(xyz_raw, DS)
    _, ref_normal = compute_tangent_normal(ref_xyz, closed=True)
    return ref_s, ref_xyz, ref_normal


def _lap_at_indices(ref_xyz: np.ndarray, indices: np.ndarray, speed_kmh: np.ndarray) -> CleanLap:
    xyz = ref_xyz[indices]
    seg = np.linalg.norm(np.diff(xyz, axis=0), axis=1)
    dist = np.concatenate([[0.0], np.cumsum(seg)])
    telemetry = pd.DataFrame({
        "X": xyz[:, 0], "Y": xyz[:, 1], "Distance": dist, "Speed": speed_kmh,
    })
    return CleanLap(driver="TST", lap_number=1.0, lap_time_s=90.0, telemetry=telemetry)


def test_extract_reference_speed_full_coverage_recovers_constant_speed():
    ref_s, ref_xyz, ref_normal = _make_circle_reference()
    n = len(ref_s)
    indices = np.arange(n)
    lap = _lap_at_indices(ref_xyz, indices, speed_kmh=np.full(n, 252.0))  # 70 m/s

    result = extract_reference_speed(lap, scale=1.0, ref_s=ref_s, ref_xyz=ref_xyz, ref_normal=ref_normal)

    assert result.coverage == pytest.approx(1.0, abs=0.01)
    assert np.allclose(result.speed_ref, 70.0, atol=0.5)


def test_extract_reference_speed_fills_gaps_by_interpolation():
    ref_s, ref_xyz, ref_normal = _make_circle_reference()
    n = len(ref_s)
    # Sparse: only every 10th reference sample has a telemetry point, with
    # a smooth *periodic* speed variation (a real reference profile is
    # periodic -- the car returns to a similar speed each lap; a
    # non-periodic ramp would create a spurious seam discontinuity that
    # the periodic smoothing filter then wraps into nearby samples,
    # confusing this test with an artifact of the test signal, not of the
    # code under test).
    indices = np.arange(0, n, 10)
    theta = 2 * np.pi * indices / n
    speed_mps = 55.0 + 5.0 * np.sin(theta)
    lap = _lap_at_indices(ref_xyz, indices, speed_kmh=speed_mps * 3.6)

    result = extract_reference_speed(lap, scale=1.0, ref_s=ref_s, ref_xyz=ref_xyz, ref_normal=ref_normal)

    assert result.coverage < 0.2  # only ~1/10th of samples are real hits
    assert np.all(np.isfinite(result.speed_ref))
    # A gap-filled sample between two known points should sit close to the
    # smooth curve its neighbors define, not be left at some placeholder.
    mid_index = 5  # halfway between known indices 0 and 10
    expected = 55.0 + 5.0 * np.sin(2 * np.pi * mid_index / n)
    assert result.speed_ref[mid_index] == pytest.approx(expected, abs=1.0)


def test_extract_reference_speed_wraps_across_seam():
    """A gap spanning the s=0/length seam must interpolate using the
    course's closed-loop wraparound, not treat index 0 and index n-1 as
    unrelated endpoints of an open interval."""
    ref_s, ref_xyz, ref_normal = _make_circle_reference()
    n = len(ref_s)
    # Every sample known except a gap straddling the seam.
    gap = set(range(n - 5, n)) | set(range(0, 5))
    indices = np.array([i for i in range(n) if i not in gap])
    lap = _lap_at_indices(ref_xyz, indices, speed_kmh=np.full(len(indices), 100.0 * 3.6))

    result = extract_reference_speed(lap, scale=1.0, ref_s=ref_s, ref_xyz=ref_xyz, ref_normal=ref_normal)

    assert np.allclose(result.speed_ref[list(gap)], 100.0, atol=1.0)


def test_reachability_violation_fraction_flags_only_unreachable_points():
    fit = GripFit(a0=20.0, k=0.0, a_cap=100.0, peak_bin_index=-1)
    curvature = np.array([0.01, 0.01, 0.01, 0.01])
    # a_lat = v^2 * kappa; grip = 20 (constant, k=0). Reachable at v=40
    # (16 <= 20), unreachable at v=60 (36 > 20).
    speed_ok = np.array([40.0, 40.0, 40.0, 40.0])
    speed_mixed = np.array([40.0, 60.0, 40.0, 60.0])

    assert reachability_violation_fraction(speed_ok, curvature, fit) == pytest.approx(0.0)
    assert reachability_violation_fraction(speed_mixed, curvature, fit) == pytest.approx(0.5)
