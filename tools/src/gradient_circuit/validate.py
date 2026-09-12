"""Acceptance-criteria checks for generated course data.

Design ref: 02_design.md section 7 (course-data criteria #1-#7).

The original criterion #7 (width clamp rate < 5%) was dropped after
measuring real lap-to-lap lateral scatter on the 2026 Monaco GP race data:
median raw full-width scatter is 0.16 m, so >96% of samples hit the floor
clamp regardless of calibration -- Monaco has essentially one viable line
almost everywhere, and that isn't a calibration defect. Width plausibility
is covered by criterion #3 (full width in [8, 12] m) instead (design 4.5).
#7 was reused for a sample-array-length check (design 5.2 invariant #2)
after a real bug: width_left/width_right were briefly computed on a
different sample grid than x/y/z/s and exported with a mismatched length
that only the web loader's (stricter) check caught -- this closes that gap
on the Python side too.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .circuits import CircuitConfig
from .reference import ADOPTED_GRIP_FIT, reachability_violation_fraction

CLOSURE_MAX = 1.0

CURVATURE_JUMP_MAX = 0.05

# Design 4.8: a residual violation rate is expected and is never clamped
# at generation time, only flagged -- design 6.14.3's runtime `min()`
# handles every violating sample regardless of how large the fraction is,
# so this criterion is a sanity net for a grossly broken reference (e.g.
# corrupted telemetry), not a precision bound. Measured baseline (2026
# Monaco GP race, 5 fastest clean laps): 8.7-9.5%, consistent across
# drivers -- see reference.py's FALLBACK_VIOLATION_THRESHOLD docstring for
# why that's expected, not a defect. Same value as that constant (cli.py
# already re-tries a slower lap above this rate at generation time, so a
# passing doc should essentially always clear this check; it exists to
# catch a doc that wasn't generated through that fallback loop, e.g.
# hand-edited).
REACHABILITY_VIOLATION_MAX = 0.20


@dataclass
class CheckResult:
    id: int
    name: str
    passed: bool
    detail: str


def run_all(doc: dict, closure_gap: float, circuit: CircuitConfig) -> list[CheckResult]:
    samples = doc["samples"]
    x = np.array(samples["x"])
    y = np.array(samples["y"])
    z = np.array(samples["z"])
    width_left = np.array(samples["widthLeft"])
    width_right = np.array(samples["widthRight"])
    curvature = np.array(samples["curvature"])

    results = []

    # Regression guard: width_left/width_right were once computed on a
    # different (pre-reparameterize_uniform) sample grid than x/y/z/s,
    # producing arrays of a different length that were silently exported
    # side by side -- caught only by the web loader's stricter check, not
    # here. Every sample array must match `count` (design 5.2 invariant #2).
    count = doc["count"]
    lengths = {name: len(samples[name]) for name in samples}
    mismatched = {name: n for name, n in lengths.items() if n != count}
    results.append(CheckResult(
        7, "sample array lengths", not mismatched,
        f"count={count}; " + (
            "all arrays match" if not mismatched
            else f"mismatched: {mismatched}"
        ),
    ))

    length = doc["length"]
    length_dev = abs(length - circuit.length_target_m) / circuit.length_target_m
    results.append(CheckResult(
        1, "course length", length_dev <= circuit.length_tolerance,
        f"length={length:.2f}m target={circuit.length_target_m}m deviation={length_dev*100:.2f}% (max {circuit.length_tolerance*100:.0f}%)",
    ))

    elevation_delta = float(z.max() - z.min())
    elev_dev = abs(elevation_delta - circuit.elevation_target_m) / circuit.elevation_target_m
    results.append(CheckResult(
        2, "elevation delta", elev_dev <= circuit.elevation_tolerance,
        f"delta={elevation_delta:.2f}m target={circuit.elevation_target_m}m deviation={elev_dev*100:.2f}% (max {circuit.elevation_tolerance*100:.0f}%)",
    ))

    full_width = width_left + width_right
    # Epsilon guards against floating-point summation noise at the clamp
    # boundary (width.py re-clamps after smoothing, but a few ULPs of drift
    # can still remain, e.g. 8.0 - 4e-15) -- the circuit's width target
    # (CircuitConfig, design 4.7) is a physical-realism bound, not a
    # bit-exact constraint.
    eps = 1e-6
    width_ok = bool(np.all((full_width >= circuit.width_min_m - eps) & (full_width <= circuit.width_max_m + eps)))
    results.append(CheckResult(
        3, "full width range", width_ok,
        f"min={full_width.min():.2f}m max={full_width.max():.2f}m target=[{circuit.width_min_m},{circuit.width_max_m}]m",
    ))

    results.append(CheckResult(
        4, "loop closure", closure_gap < CLOSURE_MAX,
        f"gap={closure_gap:.4f}m (max {CLOSURE_MAX}m)",
    ))

    curv_diff = np.abs(np.diff(np.concatenate([curvature, curvature[:1]])))
    max_jump = float(curv_diff.max())
    results.append(CheckResult(
        5, "curvature continuity", max_jump < CURVATURE_JUMP_MAX,
        f"max adjacent jump={max_jump:.4f} 1/m (max {CURVATURE_JUMP_MAX} 1/m)",
    ))

    all_arrays = [x, y, z, width_left, width_right, curvature,
                  np.array(samples["grade"]), np.array(samples["bank"])]
    has_nan_inf = any(not np.all(np.isfinite(a)) for a in all_arrays)
    results.append(CheckResult(
        6, "no NaN/Inf", not has_nan_inf, "all sample arrays finite" if not has_nan_inf else "NaN/Inf found",
    ))

    reference = doc.get("reference")
    if reference is not None:
        speed_ref = np.array(reference["speed"])
        violation = reachability_violation_fraction(speed_ref, curvature, ADOPTED_GRIP_FIT)
        results.append(CheckResult(
            24, "reference speed reachability", violation <= REACHABILITY_VIOLATION_MAX,
            f"violation_fraction={violation*100:.2f}% (max {REACHABILITY_VIOLATION_MAX*100:.0f}%), "
            f"driver={reference['driver']} lap={reference['lap_number']}",
        ))

    return results


def print_report(results: list[CheckResult]) -> bool:
    all_passed = True
    for r in results:
        status = "PASS" if r.passed else "FAIL"
        if not r.passed:
            all_passed = False
        print(f"[{status}] #{r.id} {r.name}: {r.detail}")
    return all_passed
