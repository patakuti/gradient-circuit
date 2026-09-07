"""Unit tests for width calibration/clamping.

Regression guard for the floating-point boundary bug found on real data:
smoothed full width could land a few ULPs under WIDTH_MIN (8.0 - ~4e-15).
"""

from __future__ import annotations

import numpy as np

from gradient_circuit.width import (
    apply_calibration,
    WidthCalibration,
    CLAMP_HALF_MIN,
    CLAMP_HALF_MAX,
    CLAMP_FULL_MIN,
    CLAMP_FULL_MAX,
)


def test_clamped_full_width_stays_within_bounds_after_smoothing():
    n = 500
    rng = np.random.default_rng(42)
    # Mostly near-zero scatter (like real Monaco data) with a few wider spots.
    half_left_raw = np.clip(rng.normal(0.1, 0.2, n), 0, None)
    half_right_raw = np.clip(rng.normal(0.1, 0.2, n), 0, None)
    half_left_raw[50:60] = 5.0  # a wider zone
    half_right_raw[50:60] = 5.0

    calib = WidthCalibration(k=1.6, margin=0.5)
    left, right, stats = apply_calibration(half_left_raw, half_right_raw, calib)
    full = left + right

    assert np.all(left >= CLAMP_HALF_MIN - 1e-9)
    assert np.all(left <= CLAMP_HALF_MAX + 1e-9)
    assert np.all(right >= CLAMP_HALF_MIN - 1e-9)
    assert np.all(right <= CLAMP_HALF_MAX + 1e-9)
    assert np.all(full >= CLAMP_FULL_MIN - 1e-9)
    assert np.all(full <= CLAMP_FULL_MAX + 1e-9)
    assert 0.0 <= stats["half_clamp_rate"] <= 1.0
    assert 0.0 <= stats["full_clamp_rate"] <= 1.0


def test_near_zero_scatter_floors_to_min_width():
    """Matches the real Monaco finding: near-zero scatter everywhere should
    floor to exactly the minimum full width."""
    n = 200
    half_left_raw = np.zeros(n)
    half_right_raw = np.zeros(n)
    calib = WidthCalibration(k=1.6, margin=0.5)
    left, right, _ = apply_calibration(half_left_raw, half_right_raw, calib)
    full = left + right
    assert np.allclose(full, CLAMP_FULL_MIN, atol=1e-6)
