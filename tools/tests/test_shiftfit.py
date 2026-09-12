"""Unit tests for the gear/RPM-vs-speed shift fit (design 4.10, P17.1).

Synthetic data throughout (no FastF1 dependency), same convention as
test_gripfit.py / test_reference.py.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from gradient_circuit.laps import CleanLap
from gradient_circuit.shiftfit import (
    MIN_HYSTERESIS_MPS,
    fit_rpm_vs_speed,
    fit_shift_model,
    pool_gear_rpm_samples,
)


def _synthetic_lap(gear_speed_breaks: list[tuple[int, float, float]], n_per_segment: int = 50) -> CleanLap:
    """Builds a lap that ramps speed upward through a sequence of
    (gear, speed_start, speed_end) segments, back to back -- e.g.
    [(1, 0, 20), (2, 20, 40), (3, 40, 60)] accelerates through 1st, 2nd,
    3rd gear, shifting up at 20 and 40 m/s. RPM is a fixed linear function
    of speed within each gear (rpm = 5000 + 100*speed) so the regression
    fit has an exact answer to check against.
    """
    speeds: list[float] = []
    gears: list[int] = []
    for gear, v0, v1 in gear_speed_breaks:
        seg = np.linspace(v0, v1, n_per_segment)
        speeds.extend(seg.tolist())
        gears.extend([gear] * n_per_segment)
    speed_mps = np.array(speeds)
    gear_arr = np.array(gears)
    rpm = 5000.0 + 100.0 * speed_mps
    telemetry = pd.DataFrame({
        "Speed": speed_mps * 3.6, "nGear": gear_arr, "RPM": rpm,
    })
    return CleanLap(driver="TST", lap_number=1.0, lap_time_s=90.0, telemetry=telemetry)


def test_pool_gear_rpm_samples_detects_up_and_down_shifts():
    # Accelerate 1st->2nd->3rd, then brake 3rd->2nd->1st.
    lap = _synthetic_lap([
        (1, 0.0, 20.0), (2, 20.0, 40.0), (3, 40.0, 60.0),
        (3, 60.0, 40.0), (2, 40.0, 20.0), (1, 20.0, 0.0),
    ])
    gear_samples, up_speeds, down_speeds = pool_gear_rpm_samples([lap])

    assert set(gear_samples.keys()) == {1, 2, 3}
    assert 1 in up_speeds and 2 in up_speeds
    assert 1 in down_speeds and 2 in down_speeds
    # Up-shift 1->2 happens near 20 m/s, up-shift 2->3 near 40 m/s.
    assert np.median(up_speeds[1]) == pytest.approx(20.0, abs=1.0)
    assert np.median(up_speeds[2]) == pytest.approx(40.0, abs=1.0)
    # Down-shift 2->1 happens near 20 m/s, down-shift 3->2 near 40 m/s.
    assert np.median(down_speeds[1]) == pytest.approx(20.0, abs=1.0)
    assert np.median(down_speeds[2]) == pytest.approx(40.0, abs=1.0)


def test_pool_gear_rpm_samples_ignores_neutral_and_multi_gear_jumps():
    lap = _synthetic_lap([(0, 0.0, 5.0), (1, 5.0, 20.0), (5, 20.0, 10.0), (1, 10.0, 0.0)])
    gear_samples, up_speeds, down_speeds = pool_gear_rpm_samples([lap])

    assert 0 not in gear_samples  # neutral excluded entirely
    # The 1->5 jump spans more than one boundary and must not be recorded
    # as an up-shift for gear 1, nor as a down-shift for gear 4.
    assert 1 not in up_speeds
    assert 4 not in down_speeds


def test_fit_rpm_vs_speed_recovers_exact_linear_relationship():
    lap = _synthetic_lap([(3, 40.0, 60.0)], n_per_segment=200)
    gear_samples, _, _ = pool_gear_rpm_samples([lap])

    fit = fit_rpm_vs_speed(gear_samples[3])

    assert fit.intercept == pytest.approx(5000.0, abs=1.0)
    assert fit.slope == pytest.approx(100.0, abs=0.5)
    assert fit.r_squared == pytest.approx(1.0, abs=1e-6)


def test_fit_rpm_vs_speed_rejects_too_few_samples():
    lap = _synthetic_lap([(3, 40.0, 60.0)], n_per_segment=5)
    gear_samples, _, _ = pool_gear_rpm_samples([lap])
    with pytest.raises(ValueError):
        fit_rpm_vs_speed(gear_samples[3])


def test_fit_shift_model_end_to_end():
    # A real gearbox up-shifts at a higher speed than it down-shifts at
    # the same boundary (hysteresis) -- built in here (20/18 and 40/37) so
    # "no warnings" is actually exercising the no-floor-needed path, not
    # accidentally relying on the floor to paper over a symmetric ramp.
    laps = [
        _synthetic_lap([
            (1, 0.0, 20.0), (2, 20.0, 40.0), (3, 40.0, 60.0),
            (3, 60.0, 37.0), (2, 37.0, 18.0), (1, 18.0, 0.0),
        ], n_per_segment=100)
        for _ in range(5)
    ]

    result = fit_shift_model(laps)

    assert result.gear_count == 3
    assert len(result.shift_up_speeds) == 2
    assert len(result.shift_down_speeds) == 2
    assert result.shift_up_speeds[0] == pytest.approx(20.0, abs=1.0)
    assert result.shift_up_speeds[1] == pytest.approx(40.0, abs=1.0)
    assert result.shift_down_speeds[0] == pytest.approx(18.0, abs=1.0)
    assert result.shift_down_speeds[1] == pytest.approx(37.0, abs=1.0)
    assert not result.warnings  # up-shift speed exceeds down-shift speed everywhere here


def test_fit_shift_model_applies_hysteresis_floor_when_measurement_is_noisy():
    # A pathological lap where the recorded "down-shift" speed for the
    # 1->2 boundary comes out *faster* than the up-shift speed (as if
    # sensor noise reversed the ordering) -- the floor must kick in.
    lap = _synthetic_lap([
        (1, 0.0, 20.0), (2, 20.0, 42.0),  # up-shift at 20
        (2, 42.0, 22.0), (1, 22.0, 0.0),  # down-shift at 22 (> up-shift speed)
    ], n_per_segment=100)

    result = fit_shift_model([lap])

    assert result.warnings
    assert result.shift_up_speeds[0] - result.shift_down_speeds[0] == pytest.approx(MIN_HYSTERESIS_MPS)
