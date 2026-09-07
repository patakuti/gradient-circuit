"""Unit-scale measurement for FastF1 raw X/Y/Z position coordinates.

Design ref: 02_design.md section 4.2

FastF1's raw X/Y/Z position units are commonly assumed to be 1/10 meter,
but that must be measured, not assumed (CLAUDE.md forbids implementing
platform-specific behavior on assumption). This module measures the scale
by comparing raw X/Y chordal step distances against FastF1's independently
computed `Distance` telemetry channel (integrated from speed, already in
meters) over the same samples, for every clean lap, and takes the median
across laps as the robust estimate (a few individual laps can be corrupted
or contain outlier segments; the per-lap ratio is far more stable than any
single lap in isolation -- measured: 2026 Monaco GP race, 111 clean laps,
median 0.1002, IQR [0.0997, 0.1014], with 0.1-0.2% deviation from 0.1).
"""

from __future__ import annotations

import numpy as np

from .laps import CleanLap

NOMINAL_SCALE = 0.1
TOLERANCE = 0.05  # +/-5%, per design 4.2


def _lap_scale(lap: CleanLap) -> float | None:
    xy = lap.telemetry[["X", "Y"]].to_numpy(dtype=float)
    dist = lap.telemetry["Distance"].to_numpy(dtype=float)
    raw_step = np.linalg.norm(np.diff(xy, axis=0), axis=1)
    real_step = np.diff(dist)
    total_raw = raw_step.sum()
    total_real = real_step.sum()
    if total_raw <= 0 or total_real <= 0:
        return None
    return float(total_real / total_raw)


def measure_scale(clean_laps: list[CleanLap]) -> tuple[float, dict]:
    """Measure the raw-unit-to-meter scale from clean laps.

    Returns (scale, stats) where `scale` is the value to multiply raw
    X/Y/Z coordinates by to get meters, and `stats` carries the raw
    measurement for logging/meta recording.

    Raises RuntimeError if the measured scale deviates from the nominal
    0.1 hypothesis by more than TOLERANCE -- per design, generation must
    not silently proceed with an unverified unit assumption.
    """
    per_lap_scales = [s for lap in clean_laps if (s := _lap_scale(lap)) is not None]
    if not per_lap_scales:
        raise RuntimeError("Could not measure scale: no lap produced a valid ratio")

    arr = np.array(per_lap_scales)
    measured = float(np.median(arr))
    stats = {
        "n_laps": len(arr),
        "median": measured,
        "mean": float(arr.mean()),
        "std": float(arr.std()),
        "min": float(arr.min()),
        "max": float(arr.max()),
        "p25": float(np.percentile(arr, 25)),
        "p75": float(np.percentile(arr, 75)),
    }

    deviation = abs(measured - NOMINAL_SCALE) / NOMINAL_SCALE
    if deviation > TOLERANCE:
        raise RuntimeError(
            f"Measured scale {measured:.6f} deviates from nominal "
            f"{NOMINAL_SCALE} by {deviation * 100:.1f}% (> {TOLERANCE * 100:.0f}%"
            f" tolerance). Refusing to proceed with an unverified unit "
            f"assumption. Stats: {stats}"
        )

    return NOMINAL_SCALE, stats
