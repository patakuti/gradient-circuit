"""Gear/RPM-vs-speed fit from real telemetry.

Design ref: 02_design.md section 4.10. Plan ref: 03_plan.md P17.1.

Like `gripfit.py` (design 4.9), this is a vehicle-parameter measurement,
not a course-data generation step: gear and RPM as functions of speed are
a property of the car, not of a particular circuit's `s`, so this doesn't
touch course.json at all and needs no projection onto any centerline --
it just pools (Speed, nGear, RPM) samples straight from each lap's
telemetry, in the sequential (time) order FastF1 already returns them in.

Samples from every circuit are pooled before fitting, same "the car is
one car" doctrine as design 4.9.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .laps import CleanLap

# A lap's Speed/nGear/RPM samples while stationary or crawling (pit lane,
# grid formation) are noise for this fit, not signal -- exclude nGear<=0
# (neutral) altogether; the per-gear regression and shift-speed detection
# below don't need a separate low-speed cutoff on top of that, since a
# real gear change essentially never happens standing still.
MIN_GEAR = 1

# A gear needs at least this many pooled samples for its RPM~Speed
# regression to mean anything (mirrors gripfit.py's MIN_BIN_SAMPLES intent,
# though this checks total samples per gear, not a speed bin within it).
MIN_SAMPLES_PER_GEAR = 30

# Percentiles used for idle/redline RPM instead of raw min/max, which are
# vulnerable to a single outlier sample (design 4.10).
IDLE_RPM_PERCENTILE = 5
REDLINE_RPM_PERCENTILE = 99


@dataclass(frozen=True)
class GearSamples:
    """Every pooled (speed, rpm) sample for one gear, plus every measured
    speed at which a lap shifted into (up_speeds) or out of (down_speeds,
    i.e. shifted down *from* the next gear up into this one) this gear."""

    speed_mps: np.ndarray
    rpm: np.ndarray


def pool_gear_rpm_samples(clean_laps: list[CleanLap]) -> tuple[dict[int, GearSamples], dict[int, list[float]], dict[int, list[float]]]:
    """Walk every lap's telemetry in sequence and collect:
    - per-gear (speed, rpm) samples (for the RPM~Speed regression)
    - per gear-pair (g, g+1), the speed at every up-shift g->g+1
    - per gear-pair (g, g+1), the speed at every down-shift g+1->g

    A transition's speed is the mean of the two straddling samples (the
    one still in the old gear and the first one in the new gear) -- the
    telemetry doesn't say exactly when between them the shift happened, so
    this is the least-biased single estimate available, not a precise
    instant.

    Shift speeds are keyed by the *lower* gear number of the pair (matches
    `VehicleParams.shiftUpSpeeds[g-1]`/`shiftDownSpeeds[g-1]`'s indexing in
    design 6.16: index g-1 is the boundary between gear g and gear g+1).
    """
    by_gear: dict[int, list[tuple[float, float]]] = {}
    up_speeds: dict[int, list[float]] = {}
    down_speeds: dict[int, list[float]] = {}

    for lap in clean_laps:
        speed_mps = lap.telemetry["Speed"].to_numpy(dtype=float) / 3.6
        gear = lap.telemetry["nGear"].to_numpy(dtype=int)
        rpm = lap.telemetry["RPM"].to_numpy(dtype=float)

        for i in range(len(gear)):
            g = int(gear[i])
            if g < MIN_GEAR:
                continue
            by_gear.setdefault(g, []).append((speed_mps[i], rpm[i]))

        for i in range(1, len(gear)):
            g_prev, g_cur = int(gear[i - 1]), int(gear[i])
            if g_prev < MIN_GEAR or g_cur < MIN_GEAR or g_prev == g_cur:
                continue
            transition_speed = (speed_mps[i - 1] + speed_mps[i]) / 2.0
            if g_cur == g_prev + 1:
                up_speeds.setdefault(g_prev, []).append(transition_speed)
            elif g_cur == g_prev - 1:
                down_speeds.setdefault(g_cur, []).append(transition_speed)
            # A jump spanning more than one gear (e.g. a downshift straight
            # from 5th to 2nd under heavy braking) isn't a single gear
            # boundary's transition speed -- skip it rather than attribute
            # it to a boundary it didn't actually cross one step at a time.

    gear_samples = {
        g: GearSamples(
            speed_mps=np.array([s for s, _ in pts]),
            rpm=np.array([r for _, r in pts]),
        )
        for g, pts in by_gear.items()
    }
    return gear_samples, up_speeds, down_speeds


@dataclass(frozen=True)
class GearFit:
    slope: float  # RPM per m/s
    intercept: float  # RPM at 0 m/s (extrapolated, not necessarily physical)
    n_samples: int
    r_squared: float


def fit_rpm_vs_speed(samples: GearSamples) -> GearFit:
    """Least-squares line rpm = intercept + slope*speed for one gear's
    pooled samples."""
    if len(samples.speed_mps) < MIN_SAMPLES_PER_GEAR:
        raise ValueError(
            f"only {len(samples.speed_mps)} samples for this gear, need >= {MIN_SAMPLES_PER_GEAR}"
        )
    design = np.column_stack([np.ones_like(samples.speed_mps), samples.speed_mps])
    coef, *_ = np.linalg.lstsq(design, samples.rpm, rcond=None)
    intercept, slope = float(coef[0]), float(coef[1])

    predicted = intercept + slope * samples.speed_mps
    residual = samples.rpm - predicted
    ss_res = float(np.sum(residual**2))
    ss_tot = float(np.sum((samples.rpm - samples.rpm.mean()) ** 2))
    r_squared = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0

    return GearFit(slope=slope, intercept=intercept, n_samples=len(samples.speed_mps), r_squared=r_squared)


# Minimum shift hysteresis (up-shift speed minus down-shift speed) enforced
# when the measured value comes out at or below this floor -- i.e. noise
# made the down-shift speed measure at or above the up-shift speed at that
# boundary, which would make the gear hunt every step it sits near the
# boundary (design 6.16). Not measured (design 1.1's resolution: use the
# measured difference wherever there is one; this is only the safety-net
# fallback) -- chosen as a small, plausible margin; a warning is recorded
# whenever it triggers, so a specific boundary that keeps needing it
# stands out rather than silently reverting to a guess.
MIN_HYSTERESIS_MPS = 1.0


@dataclass(frozen=True)
class ShiftFitResult:
    gear_count: int
    idle_rpm: float
    redline_rpm: float
    per_gear: dict[int, GearFit]  # keyed by gear number (1-indexed)
    shift_up_speeds: list[float]  # index g-1: gear g -> g+1 up-shift speed [m/s]
    shift_down_speeds: list[float]  # index g-1: gear g+1 -> g down-shift speed [m/s]
    shift_up_n: list[int]  # sample counts backing each shift_up_speeds entry
    shift_down_n: list[int]  # sample counts backing each shift_down_speeds entry
    warnings: list[str]


def fit_shift_model(clean_laps: list[CleanLap]) -> ShiftFitResult:
    gear_samples, up_speeds, down_speeds = pool_gear_rpm_samples(clean_laps)
    if not gear_samples:
        raise ValueError("no gear>=1 samples found across the provided laps")

    gear_count = max(gear_samples)
    per_gear = {g: fit_rpm_vs_speed(gear_samples[g]) for g in sorted(gear_samples)}

    all_rpm = np.concatenate([s.rpm for s in gear_samples.values()])
    idle_rpm = float(np.percentile(all_rpm, IDLE_RPM_PERCENTILE))
    redline_rpm = float(np.percentile(all_rpm, REDLINE_RPM_PERCENTILE))

    shift_up_speeds: list[float] = []
    shift_down_speeds: list[float] = []
    shift_up_n: list[int] = []
    shift_down_n: list[int] = []
    warnings: list[str] = []
    for g in range(1, gear_count):
        ups = up_speeds.get(g, [])
        downs = down_speeds.get(g, [])
        if not ups or not downs:
            raise ValueError(
                f"no measured {'up' if not ups else 'down'}-shift samples for the {g}->{g+1} boundary"
            )
        up_speed = float(np.median(ups))
        down_speed = float(np.median(downs))
        if up_speed - down_speed < MIN_HYSTERESIS_MPS:
            warnings.append(
                f"gear {g}->{g+1} boundary: measured hysteresis "
                f"({up_speed - down_speed:.2f} m/s) below the {MIN_HYSTERESIS_MPS} m/s floor "
                f"(up={up_speed:.2f} m/s [{len(ups)} samples], down={down_speed:.2f} m/s "
                f"[{len(downs)} samples]) -- using the floor instead of the measured value"
            )
            down_speed = up_speed - MIN_HYSTERESIS_MPS
        shift_up_speeds.append(up_speed)
        shift_down_speeds.append(down_speed)
        shift_up_n.append(len(ups))
        shift_down_n.append(len(downs))

    return ShiftFitResult(
        gear_count=gear_count, idle_rpm=idle_rpm, redline_rpm=redline_rpm, per_gear=per_gear,
        shift_up_speeds=shift_up_speeds, shift_down_speeds=shift_down_speeds,
        shift_up_n=shift_up_n, shift_down_n=shift_down_n, warnings=warnings,
    )
