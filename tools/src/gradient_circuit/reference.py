"""Reference speed profile extraction.

Design ref: 02_design.md section 4.8. Plan ref: 03_plan.md P15.1.

Unlike `gripfit.py` (a standalone measurement run against an already
*exported* course.json, design 4.9), this module is part of the course
*generation* pipeline itself: it projects the fastest clean lap's Speed
channel onto the same in-memory reference line (`ref_s`/`ref_xyz`) that
`centerline.py` builds while constructing that same run's centerline, using
the identical lap-continuity projection (`walk_lap_projection`) `width.py`'s
`project_laps` uses for `d`/`Z`. This mirrors `d_buckets`/`z_buckets`:
values come out indexed by `ref_s` (the pre-`reparameterize_uniform` grid),
not the final exported `s` grid -- the caller (cli.py) interpolates onto
the final grid with `interp_periodic`, exactly as it already does for
`width_left`/`width_right`.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.spatial import cKDTree

from .centerline import walk_lap_projection
from .gripfit import GripFit, lateral_grip_at
from .laps import CleanLap
from .width import SMOOTH_WINDOW_M, moving_average_periodic

# Mirrors web/src/sim/vehicleParams.ts's mechLateralAccel/aeroLateralCoeff/
# maxLateralAccelCap (the `tools fit-grip` result adopted in design 4.9).
# Python and TypeScript can't share a constant across the language
# boundary (same tradeoff as audio/engine.ts's CURB_BUMP_PERIOD_M, design
# 6.11) -- kept in sync by hand when the grip fit is redone.
# peak_bin_index is a fit-report diagnostic (gripfit.py's own fitting
# process); it plays no role in lateral_grip_at's a0/k/a_cap evaluation,
# so -1 here is an unused sentinel, not a measured value.
ADOPTED_GRIP_FIT = GripFit(a0=19.46, k=0.00736, a_cap=60.88, peak_bin_index=-1)

# A reachability violation fraction above this is treated as "this lap's
# telemetry/projection is unreliable for a reference profile", not "a
# handful of genuinely tight corners" -- see extract_reference_speed's
# module-level fallback loop in cli.py.
#
# Measured (2026 Monaco GP race, `tools generate`): the 5 fastest clean
# laps (ANT x3, HAM x2) all land at 8.7-9.5% violation -- consistent
# across different drivers/laps, so this is not lap-specific noise. It's
# the expected residual of fitting a single a0+k*v^2 curve to a p95
# envelope *per speed bin* (design 4.9): a single fast lap can ride above
# that curve at various points spread across many bins without any one
# bin's p95 being exceeded, so the pointwise violation rate across a whole
# lap naturally runs higher than the 5% envelope percentile itself. This
# is harmless at runtime -- design 6.14.3's `min(referenceSpeed, vGrip)`
# clamps every such point to the grip limit regardless of how large the
# violation fraction is. The threshold below is a sanity net for a
# genuinely broken reference (corrupted telemetry, wrong lap), set well
# above the ~9% observed baseline, not a precision bound. High confidence
# in the ~9% baseline (directly measured); the exact margin above it
# (rather than some other value) is a judgment call.
FALLBACK_VIOLATION_THRESHOLD = 0.20


@dataclass(frozen=True)
class ReferenceSpeedResult:
    driver: str
    lap_number: float
    lap_time_s: float
    coverage: float  # fraction of ref_s samples with >=1 real (non-interpolated) point
    speed_ref: np.ndarray  # (len(ref_s),) [m/s], indexed by ref_s -- caller interpolates onto final s
    known_mask: np.ndarray  # (len(ref_s),) bool, True where speed_ref is a real (not gap-filled) value


def extract_reference_speed(
    lap: CleanLap, scale: float, ref_s: np.ndarray, ref_xyz: np.ndarray, ref_normal: np.ndarray,
) -> ReferenceSpeedResult:
    """Project one lap's Speed channel onto the reference line and fill
    gaps in the 1 m grid by periodic linear interpolation (design 4.8).

    Does not use the telemetry `Distance` column to place samples along
    `s` (design 4.8: it drifts from the course's own arc length by tens of
    meters and would misalign speed against curvature at sharp corners).
    Reuses the same lap-continuity XY projection `centerline.py` uses for
    `d`/`Z`, applied to `Speed` instead, so this doesn't duplicate a second
    position-matching approach.
    """
    n = len(ref_s)
    tree = cKDTree(ref_xyz[:, :2])
    buckets: list[list[float]] = [[] for _ in range(n)]

    pts = lap.telemetry[["X", "Y"]].to_numpy(dtype=float) * scale
    dist = lap.telemetry["Distance"].to_numpy(dtype=float)
    speed_kmh = lap.telemetry["Speed"].to_numpy(dtype=float)

    for pi, anchor_i, _best_d in walk_lap_projection(pts, dist, ref_s, ref_xyz, ref_normal, tree):
        buckets[anchor_i].append(speed_kmh[pi] / 3.6)

    known_mask = np.array([bool(b) for b in buckets])
    coverage = float(np.mean(known_mask))
    if not known_mask.any():
        raise ValueError(f"{lap.driver} #{lap.lap_number}: no telemetry points projected onto the reference line")

    speed_known = np.array([float(np.median(b)) if b else 0.0 for b in buckets])
    filled = _fill_periodic_gaps(ref_s, speed_known, known_mask)
    # Linear interpolation across a long gap (design 4.8: ~83% of the grid
    # has no real telemetry point, see the module-level coverage note) can
    # leave a kink right at a gap's real-sample endpoints -- measured on
    # the 2026 Monaco GP race data, one such kink reached 5.3 m/s across a
    # single 1 m step (mean step-to-step change elsewhere: 0.19 m/s).
    # Reuses width.py's periodic moving average and its already-established
    # SMOOTH_WINDOW_M (design 4.5): both are "smooth a sparse-telemetry-
    # projected signal on the same 1 m grid" problems. The window itself
    # was tuned for lateral scatter, not speed, so this is a reasonable
    # starting point (medium confidence), not a speed-specific fit.
    speed_ref = moving_average_periodic(filled, SMOOTH_WINDOW_M)

    return ReferenceSpeedResult(
        driver=lap.driver, lap_number=lap.lap_number, lap_time_s=lap.lap_time_s,
        coverage=coverage, speed_ref=speed_ref, known_mask=known_mask,
    )


def _fill_periodic_gaps(ref_s: np.ndarray, values: np.ndarray, known_mask: np.ndarray) -> np.ndarray:
    """Linearly interpolate the samples where `known_mask` is False, from
    the nearest known samples on either side, wrapping across the
    s=0/length seam (the course is a closed loop)."""
    length = ref_s[-1] + (ref_s[1] - ref_s[0])
    known_s = ref_s[known_mask]
    known_v = values[known_mask]
    ext_s = np.concatenate([known_s - length, known_s, known_s + length])
    ext_v = np.concatenate([known_v, known_v, known_v])
    return np.interp(ref_s, ext_s, ext_v)


def reachability_violation_fraction(
    speed_ref: np.ndarray, curvature: np.ndarray, fit: GripFit = ADOPTED_GRIP_FIT,
) -> float:
    """Fraction of samples where the reference speed demands more lateral
    grip than the adopted model provides (design 4.8's reachability
    check). Both arrays must already be on the same (final, exported) `s`
    grid."""
    a_lat = speed_ref**2 * np.abs(curvature)
    grip = lateral_grip_at(speed_ref, fit)
    violated = a_lat > grip
    return float(np.mean(violated))
