"""Curvature, grade and (conditionally) bank angle from the smoothed centerline.

Design ref: 02_design.md section 4.6

Sign convention: curvature and the reference-line normal (centerline.py's
compute_tangent_normal) are both derived by rotating the horizontal tangent
+90 degrees to get "left". This was verified against real-world direction,
not just assumed self-consistent: Monaco is universally driven clockwise
(viewed from a standard north-up map), so the signed heading change over
one full lap (sum(curvature) * ds) must equal -360 degrees under this
convention. Measured on the generated centerline: -360.24 degrees (cross-
checked independently via unwrapped tangent-angle differences: -359.95
degrees) -- confirms the sign convention matches true left/right, not
merely an internally-consistent but possibly mirrored axis. (An initial,
memory-based assumption that the Fairmont Hairpin -- the tightest corner in
F1 -- must individually read as a right-hander was checked against this
result and turned out to be an unreliable way to verify a global axis
convention from a single corner; the whole-lap check above is the one that
actually holds up and is what this convention rests on.) See tests/ for the
regression check on generated data.
"""

from __future__ import annotations

import numpy as np
from scipy import stats as scipy_stats

# compute_curvature lives in centerline.py (not here) so that module's own
# chicane-adaptive smoothing (P12 follow-up) can use it without a circular
# import (geometry.py already depends on centerline.py for DS). Re-exported
# below so `from .geometry import compute_curvature` keeps working.
from .centerline import DS, compute_curvature

__all__ = ["compute_curvature", "compute_grade", "evaluate_bank_significance", "compute_bank_zero"]


def compute_grade(xyz: np.ndarray) -> np.ndarray:
    """grade = asin(dz/ds), central differences, periodic. Uphill positive."""
    z = xyz[:, 2]
    dz = (np.roll(z, -1) - np.roll(z, 1)) / (2 * DS)
    dz_clamped = np.clip(dz, -1.0, 1.0)
    return np.arcsin(dz_clamped)


def evaluate_bank_significance(
    d_buckets: list[list[float]], z_buckets: list[list[float]]
) -> dict:
    """Per-sample linear regression of Z on lateral offset d, to test whether
    a cross-track (banking) slope can be reliably recovered.

    Returns aggregate stats (median R^2, median slope std-error, fraction of
    samples with a "significant" fit) used to decide bank_source in cli.py.
    Design 4.6: must be measured, not assumed.
    """
    n = len(d_buckets)
    r_squared = []
    slope_stderr = []
    n_points = []
    for i in range(n):
        d = np.asarray(d_buckets[i])
        z = np.asarray(z_buckets[i])
        if len(d) < 5 or np.ptp(d) < 0.5:
            continue
        result = scipy_stats.linregress(d, z)
        r_squared.append(result.rvalue**2)
        slope_stderr.append(result.stderr)
        n_points.append(len(d))

    if not r_squared:
        return {
            "n_samples_evaluated": 0,
            "median_r2": 0.0,
            "median_slope_stderr": float("inf"),
            "frac_significant": 0.0,
        }

    r_squared = np.array(r_squared)
    slope_stderr = np.array(slope_stderr)
    # "significant" heuristic: R^2 > 0.3 (slope explains a non-trivial share
    # of Z variance) -- see cli.py / tools/tests for the measured outcome on
    # the actual dataset and the resulting accept/reject decision.
    significant = r_squared > 0.3

    return {
        "n_samples_evaluated": len(r_squared),
        "median_r2": float(np.median(r_squared)),
        "median_slope_stderr": float(np.median(slope_stderr)),
        "frac_significant": float(np.mean(significant)),
    }


def compute_bank_zero(n: int) -> np.ndarray:
    return np.zeros(n)
