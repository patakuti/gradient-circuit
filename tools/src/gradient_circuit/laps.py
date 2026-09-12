"""Clean lap extraction.

Design ref: 02_design.md section 4.3

A lap is considered "clean" (usable for centerline / width estimation) when:
- it does not include a pit stop (PitInTime and PitOutTime are both NaT)
- its lap time is within 1.10x the median lap time of all otherwise-valid laps
  (this excludes safety car / VSC / red flag / formation laps)
- it has valid, non-degenerate position telemetry

Measured against the 2026 Monaco GP race session: `lap.get_pos_data()`
returns the raw position stream at its native ~3-5 Hz rate (as few as ~20-100
points per lap), which is too sparse to build an accurate centerline.
`lap.get_telemetry()` merges position with the higher-rate car channels and
interpolates X/Y/Z onto that finer time base (~300-450 points per lap for
Monaco), giving a much better base for the resampling/smoothing pipeline. It
also carries a `Distance` column (meters, integrated from speed) that is
independent of the raw X/Y/Z unit convention and is used to measure the
X/Y/Z raw-unit-to-meter scale (see `scale.py`).

A mid-race position-data outage was found affecting many drivers around the
same lap window: their position stream comes back as an all-zero trace for
that lap. This is a real data quality issue (verified: constant zero span,
correlated across drivers at the same lap numbers), not a bug in this code,
so such laps are detected and excluded via `MIN_POSITION_SPAN`.
"""

from __future__ import annotations

from dataclasses import dataclass

import fastf1
import pandas as pd

LAP_TIME_TOLERANCE = 1.10
MIN_RECOMMENDED_LAPS = 20

# Minimum raw-unit span (X or Y) a lap's telemetry trace must have to be
# considered valid. A full Monaco lap spans several thousand raw units;
# the observed degenerate/outage traces are exactly zero. 500 raw units
# (=50 m at the measured scale=0.1) sits far below any real lap span and
# comfortably above the degenerate case.
MIN_POSITION_SPAN = 500.0

# A lap's telemetry must have at least this many points to be usable for
# spline fitting.
MIN_TELEMETRY_POINTS = 50


@dataclass(frozen=True)
class CleanLap:
    driver: str
    lap_number: float
    lap_time_s: float
    # columns: X, Y, Z, Distance (raw FastF1 units; Distance in meters),
    # Speed (km/h, car-channel measurement -- unlike X/Y/Z it is not GPS
    # derived, so gripfit.py trusts it directly; design 4.9), nGear/RPM
    # (car-channel, same source as Speed; design 4.10, shiftfit.py).
    telemetry: pd.DataFrame


def _clean_telemetry(lap: fastf1.core.Lap) -> pd.DataFrame | None:
    try:
        tel = lap.get_telemetry()
    except Exception:
        return None
    needed = {"X", "Y", "Z", "Distance", "Speed", "nGear", "RPM"}
    if tel is None or tel.empty or not needed.issubset(tel.columns):
        return None
    if len(tel) < MIN_TELEMETRY_POINTS:
        return None
    x_span = tel["X"].max() - tel["X"].min()
    y_span = tel["Y"].max() - tel["Y"].min()
    if max(x_span, y_span) < MIN_POSITION_SPAN:
        return None
    return tel[["X", "Y", "Z", "Distance", "Speed", "nGear", "RPM"]].reset_index(drop=True)


def extract_clean_laps(session: fastf1.core.Session) -> list[CleanLap]:
    """Extract clean laps usable for centerline/width estimation.

    Returns a list of CleanLap. Raises RuntimeError if no laps qualify.
    """
    laps = session.laps
    if laps is None or laps.empty:
        raise RuntimeError("Session has no laps loaded")

    # First pass: laps with valid telemetry and no pit stop, to compute a
    # representative median lap time.
    candidates: list[tuple[fastf1.core.Lap, pd.DataFrame, float]] = []
    for _, lap in laps.iterlaps():
        if pd.notna(lap["PitInTime"]) or pd.notna(lap["PitOutTime"]):
            continue
        lap_time = lap["LapTime"]
        if pd.isna(lap_time):
            continue
        tel = _clean_telemetry(lap)
        if tel is None:
            continue
        candidates.append((lap, tel, lap_time.total_seconds()))

    if not candidates:
        raise RuntimeError(
            "No candidate laps with valid telemetry and no pit stop were found"
        )

    lap_times = pd.Series([c[2] for c in candidates])
    median_time = float(lap_times.median())
    threshold = median_time * LAP_TIME_TOLERANCE

    clean: list[CleanLap] = []
    for lap, tel, lap_time_s in candidates:
        if lap_time_s > threshold:
            continue
        clean.append(
            CleanLap(
                driver=str(lap["Driver"]),
                lap_number=float(lap["LapNumber"]),
                lap_time_s=lap_time_s,
                telemetry=tel,
            )
        )

    if not clean:
        raise RuntimeError("No clean laps remained after lap-time filtering")

    if len(clean) < MIN_RECOMMENDED_LAPS:
        print(
            f"WARNING: only {len(clean)} clean laps found (< "
            f"{MIN_RECOMMENDED_LAPS}); width estimation reliability may be "
            "reduced.",
        )

    return clean


def fastest_lap(clean_laps: list[CleanLap]) -> CleanLap:
    return min(clean_laps, key=lambda lap: lap.lap_time_s)
