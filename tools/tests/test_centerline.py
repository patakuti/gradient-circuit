"""Unit tests for the arc-length resampling / closure invariants, and for
project_laps' lap-continuity point matching.

Design ref: 02_design.md section 5.2 (invariants #3, #4), section 4.4 step 2.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from gradient_circuit.centerline import (
    DS,
    _sample_count_for_closed_loop,
    compute_tangent_normal,
    project_laps,
    reparameterize_uniform,
    closure_error,
)
from gradient_circuit.laps import CleanLap


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


def _smoothstep(t: np.ndarray) -> np.ndarray:
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _make_crossover_reference(n_raw: int = 3000):
    """A closed reference line that is mostly a simple circle, except two
    far-apart-in-s regions each run, for a stretch of ~40 raw samples, along
    a straight line only 1.5 m apart from the *other* region's line (with a
    smooth ramp on/off the circle at each end) -- simulating a grade-
    separated crossover like Suzuka's figure-eight, where the upper and
    lower levels run close and parallel for some distance, not just touch
    at a single point. Different Z per branch. Built at high raw resolution
    then run through `reparameterize_uniform`, exactly as the real pipeline
    does (`build_reference_line` + `smooth_periodic` + `reparameterize_uniform`
    in cli.py), so `ref_s[i]` is guaranteed to equal the *actual* geometric
    arc length to sample i -- required for project_laps' Distance-based
    matching to mean anything, and easy to get wrong by hand-rolling `ref_s
    = i * ds` for a distorted curve that isn't actually uniformly spaced.
    """
    theta = np.linspace(0.0, 2 * np.pi, n_raw, endpoint=False)
    radius = 200.0
    x = radius * np.cos(theta)
    y = radius * np.sin(theta)
    z = np.zeros(n_raw)

    ramp = int(n_raw * 0.015)
    flat = int(n_raw * 0.013)  # samples on each side of center held on the straight line
    half_window = ramp + flat
    for theta_center, y_offset, z_level in ((np.pi / 2, -0.2, 0.0), (3 * np.pi / 2, 0.2, 20.0)):
        i_center = int(round(theta_center / (2 * np.pi) * n_raw))
        for di in range(-half_window, half_window + 1):
            i = (i_center + di) % n_raw
            if abs(di) <= flat:
                w = 1.0
            else:
                w = _smoothstep(1.0 - (abs(di) - flat) / ramp)
            circle_pt = np.array([x[i], y[i]])
            # A straight line (local "x" = di, offset "y" = y_offset) so the
            # two branches run parallel and only y_offset apart (0.4 m
            # total -- comparable to realistic GPS/racing-line noise, see
            # _lap_tracing_branch) across the whole flat region, not just
            # at one point.
            target_pt = np.array([float(di), y_offset])
            blended = (1.0 - w) * circle_pt + w * target_pt
            x[i], y[i] = blended
            z[i] = (1.0 - w) * z[i] + w * z_level

    xyz_raw = np.column_stack([x, y, z])
    ref_s, ref_xyz = reparameterize_uniform(xyz_raw, DS)
    _, ref_normal = compute_tangent_normal(ref_xyz, closed=True)
    return ref_s, ref_xyz, ref_normal


def _nearest_index(ref_xyz: np.ndarray, point: np.ndarray, i_range: tuple[int, int]) -> int:
    lo, hi = i_range
    d2 = np.sum((ref_xyz[lo:hi, :2] - point) ** 2, axis=1)
    return lo + int(np.argmin(d2))


def _lap_tracing_branch(ref_s, ref_xyz, i_lo: int, i_hi: int, xy_noise_std: float = 0.0, seed: int = 0) -> CleanLap:
    """A synthetic clean lap whose telemetry traces reference indices
    [i_lo, i_hi), with `Distance` = cumulative arc length of the *clean*
    (pre-noise) path (matching reality: FastF1's Distance channel is
    integrated from speed, not derived from the noisy X/Y position). XY
    noise simulates that a lap other than the fastest one (which the
    reference line itself is built from) never drives the exact reference
    line -- it's the realistic condition under which two branches merely
    close in XY (not touching) actually get confused by nearest-XY-only
    matching."""
    idx = np.arange(i_lo, i_hi)
    xyz = ref_xyz[idx].copy()
    seg = np.linalg.norm(np.diff(xyz, axis=0), axis=1)
    dist = np.concatenate([[0.0], np.cumsum(seg)])
    if xy_noise_std > 0:
        rng = np.random.default_rng(seed)
        xyz[:, :2] += rng.normal(0.0, xy_noise_std, size=(len(idx), 2))
    telemetry = pd.DataFrame({
        "X": xyz[:, 0], "Y": xyz[:, 1], "Z": xyz[:, 2], "Distance": dist,
    })
    return CleanLap(driver="TST", lap_number=1.0, lap_time_s=90.0, telemetry=telemetry)


def test_project_laps_resolves_crossover_by_lap_continuity():
    """Regression guard for the real bug found on 2026 Japanese GP (Suzuka)
    data: nearest-XY-only matching at a grade-separated crossover pulled
    points from the wrong level into a reference sample's z_buckets (up to
    ~20 m of spurious spread there), producing a physically impossible
    grade wiggle in the exported course. A lap that only ever drives
    branch A must not contaminate branch B's z_buckets, even under
    realistic GPS/racing-line noise comparable to the branches' own 0.4 m
    separation -- exactly the condition nearest-XY-only matching fails
    under (verified separately against the pre-fix algorithm)."""
    ref_s, ref_xyz, ref_normal = _make_crossover_reference()
    n = len(ref_s)
    i_a = _nearest_index(ref_xyz, np.array([0.0, -0.2]), (0, n // 2))  # branch A: z=0
    i_b = _nearest_index(ref_xyz, np.array([0.0, 0.2]), (n // 2, n))  # branch B: z=20

    span = 45  # samples on each side of the pinch center to cover flat+ramp
    lap = _lap_tracing_branch(ref_s, ref_xyz, i_lo=i_a - span, i_hi=i_a + span, xy_noise_std=0.3)

    d_buckets, z_buckets = project_laps([lap], scale=1.0, ref_s=ref_s, ref_xyz=ref_xyz, ref_normal=ref_normal)

    # Branch A samples (this lap's own path) should be populated with z=0.
    near_a = range(i_a - 5, i_a + 6)
    for i in near_a:
        assert z_buckets[i], f"branch A sample {i} got no points"
        assert all(z == pytest.approx(0.0, abs=1e-6) for z in z_buckets[i])

    # Branch B (z=20, a different lap entirely) must stay untouched by this
    # lap -- this is exactly what nearest-XY-only matching would violate.
    for i in range(i_b - 5, i_b + 6):
        assert z_buckets[i] == []


def test_project_laps_tracks_through_racing_line_drift():
    """Regression guard for a real failure found while building the fix
    above: a first attempt anchored each point to a single *per-lap*
    Distance offset (course-s corresponding to this lap's Distance==0).
    That failed on real Suzuka data because different laps take different
    racing lines -- a lap's cumulative path length drifts from the
    reference line's arc length by tens of meters over a few hundred
    meters of track (measured: ~25 m drift over 200 m for a real,
    non-reference lap), far past any reasonably-sized fixed window.

    This constructs a lap that cuts a quarter of the circle on a
    noticeably tighter (shorter) radius than the reference before
    rejoining the reference line exactly, accumulating ~47 m less
    Distance than the reference's arc length predicts. Points after the
    rejoin must still land on their true (angularly correct) reference
    sample -- sequential per-step tracking (anchored to the previous
    point, not a lap-wide offset) should be immune to this; a global
    per-lap-offset approach is not."""
    n_raw = 4000
    theta = np.linspace(0.0, 2 * np.pi, n_raw, endpoint=False)
    radius = 200.0
    ref_xyz_raw = np.column_stack([radius * np.cos(theta), radius * np.sin(theta), np.zeros(n_raw)])
    ref_s, ref_xyz = reparameterize_uniform(ref_xyz_raw, DS)
    _, ref_normal = compute_tangent_normal(ref_xyz, closed=True)
    n = len(ref_s)

    # Lap: quarter circle (0 -> pi/2) on a tighter radius, then rejoins the
    # reference exactly for the next quarter (pi/2 -> pi).
    tight_theta = np.linspace(0.0, np.pi / 2, n_raw // 4, endpoint=False)
    tight_radius = 170.0
    tight_xyz = np.column_stack([
        tight_radius * np.cos(tight_theta), tight_radius * np.sin(tight_theta), np.zeros(len(tight_theta)),
    ])
    rejoin_theta = np.linspace(np.pi / 2, np.pi, n_raw // 4, endpoint=False)
    rejoin_xyz = np.column_stack([
        radius * np.cos(rejoin_theta), radius * np.sin(rejoin_theta), np.zeros(len(rejoin_theta)),
    ])
    lap_xyz = np.vstack([tight_xyz, rejoin_xyz])
    seg = np.linalg.norm(np.diff(lap_xyz, axis=0), axis=1)
    dist = np.concatenate([[0.0], np.cumsum(seg)])
    telemetry = pd.DataFrame({
        "X": lap_xyz[:, 0], "Y": lap_xyz[:, 1], "Z": lap_xyz[:, 2], "Distance": dist,
    })
    lap = CleanLap(driver="TST", lap_number=1.0, lap_time_s=90.0, telemetry=telemetry)

    quarter_arc = (np.pi / 2) * radius
    drift = quarter_arc - (np.pi / 2) * tight_radius
    assert drift > 40.0  # sanity check the scenario is as drastic as intended

    d_buckets, z_buckets = project_laps([lap], scale=1.0, ref_s=ref_s, ref_xyz=ref_xyz, ref_normal=ref_normal)

    # Check a handful of points from the *rejoined* (exactly-on-reference)
    # portion: each must land within a couple of samples of its true
    # angular position, not offset by anything close to `drift`.
    for theta_check in (0.6 * np.pi, 0.7 * np.pi, 0.8 * np.pi, 0.9 * np.pi):
        true_i = int(round((theta_check / (2 * np.pi)) * n)) % n
        found = [i for i in range(true_i - 3, true_i + 4) if z_buckets[i % n]]
        assert found, f"no match within 3 samples of true index {true_i} (theta={theta_check:.2f}); drift={drift:.1f}m"


def test_project_laps_rejects_isolated_z_glitch_not_the_recovery_point():
    """Regression guard for the real bug found on 2026 Japanese GP (Suzuka)
    data: this was never a matching/bucketing problem (positions matched
    correctly, verified by tracing individual laps) -- GPS altitude itself
    has isolated 1-2 sample spikes of 10-20 m at Suzuka's two crossovers,
    consistently at the same XY location across many unrelated laps
    (consistent with bridge/underpass multipath), each implying >100%
    instantaneous grade and reversing immediately after. A single such
    spike must drop that point entirely (d_buckets/z_buckets stay paired
    per index -- geometry.py's bank-angle regression assumes it) without
    also rejecting the very next, perfectly normal sample that recovers
    back to the true elevation."""
    # project_laps assumes a genuinely closed, uniformly DS-spaced reference
    # line (what `reparameterize_uniform` always produces in the real
    # pipeline -- see _make_crossover_reference above for why hand-rolling
    # `ref_s = i * ds` for a non-uniform curve breaks things).
    n_raw = 4000
    theta = np.linspace(0.0, 2 * np.pi, n_raw, endpoint=False)
    radius = 400.0
    ref_xyz_raw = np.column_stack([radius * np.cos(theta), radius * np.sin(theta), np.zeros(n_raw)])
    ref_s, ref_xyz = reparameterize_uniform(ref_xyz_raw, DS)
    ref_xyz[:, 2] = 80.0
    _, ref_normal = compute_tangent_normal(ref_xyz, closed=True)
    n = len(ref_s)

    glitch_i = n // 4  # away from the loop seam at index 0
    lap = _lap_tracing_branch(ref_s, ref_xyz, i_lo=glitch_i - 50, i_hi=glitch_i + 50)
    glitch_pi = 50  # local index of glitch_i within the traced lap
    lap.telemetry.loc[glitch_pi, "Z"] = 95.0  # isolated spike: +15 m over ~1 m = ~1500% grade

    d_buckets, z_buckets = project_laps([lap], scale=1.0, ref_s=ref_s, ref_xyz=ref_xyz, ref_normal=ref_normal)

    assert d_buckets[glitch_i] == [] and z_buckets[glitch_i] == [], "the glitched point must be dropped entirely"
    assert z_buckets[glitch_i + 1] == pytest.approx([80.0]), "the very next (recovering) sample must not be rejected too"
    assert z_buckets[glitch_i - 1] == pytest.approx([80.0])
    assert len(d_buckets[glitch_i + 1]) == len(z_buckets[glitch_i + 1])  # stay paired everywhere
