"""Unit tests for the arc-length resampling / closure invariants.

Design ref: 02_design.md section 5.2 (invariants #3, #4).
"""

from __future__ import annotations

import numpy as np
import pytest

from gradient_circuit.centerline import (
    DS,
    _sample_count_for_closed_loop,
    reparameterize_uniform,
    closure_error,
)


def _make_circle(radius: float, n: int = 5000) -> np.ndarray:
    theta = np.linspace(0, 2 * np.pi, n, endpoint=False)
    return np.column_stack([radius * np.cos(theta), radius * np.sin(theta), np.zeros(n)])


@pytest.mark.parametrize("radius", [10.0, 80.123, 500.7])
def test_sample_count_gives_closing_gap_within_ds(radius):
    circumference = 2 * np.pi * radius
    n = _sample_count_for_closed_loop(circumference, DS)
    last_s = (n - 1) * DS
    gap = circumference - last_s
    assert 0.0 <= gap < DS


def test_reparameterize_uniform_spacing_and_closure():
    """Regression guard for the real bug found on Monaco data: naive
    round()-based sample counts could leave the closing gap up to 1.5*ds,
    and un-reparameterized smoothed curves could have >1% spacing error."""
    circle = _make_circle(radius=200.0, n=3000)
    s, out = reparameterize_uniform(circle, DS)

    diffs = np.linalg.norm(np.diff(out, axis=0), axis=1)
    deviation = np.abs(diffs - DS) / DS
    assert np.max(deviation) < 0.01  # design 5.2 invariant #3

    gap = closure_error(out)
    assert gap < DS  # design 4.4 step 7 / 5.2 invariant #4
