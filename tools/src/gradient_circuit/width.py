"""Track width estimation from lap-to-lap lateral scatter.

Design ref: 02_design.md section 4.5

At each sample s, the lateral offsets `d` of all clean-lap points that
projected near it (see centerline.py) form a distribution. The 2nd/98th
percentiles approximate how far left/right cars actually drove, which
underestimates the physical track width (drivers don't use every centimeter
of tarmac). A calibration factor `k` and margin correct for that; both are
determined empirically (measure_calibration_candidates), not assumed.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

PCTL_LO = 2
PCTL_HI = 98

# Half-width sanity clamp: generic bounds (not circuit-specific), applied
# before the full-width target from CircuitConfig (design 4.7) is enforced.
CLAMP_HALF_MIN = 3.0
CLAMP_HALF_MAX = 7.0

SMOOTH_WINDOW_M = 31  # periodic moving-average window [m], per design 4.5


@dataclass
class WidthCalibration:
    k: float
    margin: float


def raw_half_widths(d_buckets: list[list[float]]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (half_left_raw, half_right_raw, d_med) before calibration/clamp.

    half_left_raw(s)  = p98(d) - median(d)
    half_right_raw(s) = median(d) - p2(d)
    """
    n = len(d_buckets)
    half_left = np.zeros(n)
    half_right = np.zeros(n)
    d_med = np.zeros(n)
    for i, bucket in enumerate(d_buckets):
        if not bucket:
            continue
        arr = np.asarray(bucket)
        med = float(np.median(arr))
        hi = float(np.percentile(arr, PCTL_HI))
        lo = float(np.percentile(arr, PCTL_LO))
        d_med[i] = med
        half_left[i] = max(0.0, hi - med)
        half_right[i] = max(0.0, med - lo)
    return half_left, half_right, d_med


def _moving_average_periodic(x: np.ndarray, window_m: int) -> np.ndarray:
    n = len(x)
    w = min(window_m, n if n % 2 == 1 else n - 1)
    if w < 3:
        return x.copy()
    kernel = np.ones(w) / w
    padded = np.concatenate([x[-(w // 2):], x, x[: w // 2]])
    smoothed = np.convolve(padded, kernel, mode="valid")
    return smoothed[: n]


def apply_calibration(
    half_left_raw: np.ndarray,
    half_right_raw: np.ndarray,
    calib: WidthCalibration,
    width_min_m: float,
    width_max_m: float,
) -> tuple[np.ndarray, np.ndarray, dict]:
    """Apply k/margin, clamp to physically plausible ranges, smooth.

    `width_min_m`/`width_max_m` are the circuit's full-width clamp target
    (design 4.7, CircuitConfig) -- measured per-circuit, not assumed.

    Returns (width_left, width_right, stats) where stats reports how often
    clamping triggered (design 4.5: should be < 5% of samples, acceptance
    criterion #7).
    """
    left = calib.k * half_left_raw + calib.margin
    right = calib.k * half_right_raw + calib.margin

    left_clamped, right_clamped, full, full_clamped = _clamp_pair(left, right, width_min_m, width_max_m)

    n = len(left_clamped)
    half_clamp_hits = int(np.sum((left != left_clamped) | (right != right_clamped)))
    full_clamp_hits = int(np.sum(full != full_clamped))
    stats = {
        "half_clamp_rate": half_clamp_hits / n,
        "full_clamp_rate": full_clamp_hits / n,
    }

    left_smoothed = _moving_average_periodic(left_clamped, SMOOTH_WINDOW_M)
    right_smoothed = _moving_average_periodic(right_clamped, SMOOTH_WINDOW_M)

    # Re-clamp after smoothing: the moving average of already-in-range
    # values stays in range mathematically, but floating-point summation
    # error can push the result a few ULPs outside [WIDTH_MIN, WIDTH_MAX]
    # (measured: full width as low as 7.9999999999999964, i.e. 8.0 minus
    # ~4e-15) -- exactly the kind of boundary miss validate.py's exact
    # comparison is meant to catch. Clamping again guarantees the invariant
    # holds for the values actually written to the JSON, not just "in
    # exact arithmetic".
    left_final, right_final, _, _ = _clamp_pair(left_smoothed, right_smoothed, width_min_m, width_max_m)

    return left_final, right_final, stats


def _clamp_pair(
    left: np.ndarray, right: np.ndarray, full_min_m: float, full_max_m: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Clamp half-widths to [CLAMP_HALF_MIN, CLAMP_HALF_MAX] and their sum to
    [full_min_m, full_max_m], rescaling left/right proportionally when the
    full-width clamp changes the total (preserves the centerline offset
    between left/right rather than shifting it)."""
    left_c = np.clip(left, CLAMP_HALF_MIN, CLAMP_HALF_MAX)
    right_c = np.clip(right, CLAMP_HALF_MIN, CLAMP_HALF_MAX)
    full = left_c + right_c
    full_c = np.clip(full, full_min_m, full_max_m)
    scale_factor = np.where(full > 0, full_c / full, 1.0)
    return left_c * scale_factor, right_c * scale_factor, full, full_c
