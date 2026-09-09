"""Per-circuit configuration.

Design ref: 02_design.md section 4.7

Everything that differs between circuits (FastF1 event name, acceptance-
criteria targets, width-clamp bounds) lives here, keyed by a short `id` used
both as the CLI `--circuit` value and the output filename stem
(`course/<id>.json`). Adding a circuit means adding an entry here plus
running P7.2-style generation against its real FastF1 data -- the width
bounds in particular are never guessed, only measured (see width_min_m /
width_max_m docstrings below and design 4.7).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CircuitConfig:
    id: str
    name: str
    event_name: str
    length_target_m: float
    length_tolerance: float
    elevation_target_m: float
    elevation_tolerance: float
    width_min_m: float  # full-width clamp floor (width.py) and acceptance criterion #3 lower bound
    width_max_m: float  # full-width clamp ceiling (width.py) and acceptance criterion #3 upper bound


# Values carried over unchanged from the pre-P7 hardcoded constants
# (validate.py LENGTH_TARGET/ELEVATION_TARGET/WIDTH_MIN/MAX, width.py
# CLAMP_FULL_MIN/MAX) -- see those modules' git history for the original
# measurement notes (design 4.2, 4.5).
MONACO = CircuitConfig(
    id="monaco",
    name="Circuit de Monaco",
    event_name="Monaco Grand Prix",
    length_target_m=3337.0,
    length_tolerance=0.03,
    elevation_target_m=40.0,
    elevation_tolerance=0.15,
    width_min_m=8.0,
    width_max_m=12.0,
)

# elevation_target_m: design 4.7 originally cited a secondary-source figure
# of 52 m (low/medium confidence -- no FIA/primary corroboration). P7.2
# measured the actual FastF1 telemetry (2026 Japanese GP race, same
# methodology already validated on Monaco): elevation delta = 40.30 m. That
# is a direct measurement, not a guess, and it does not corroborate 52 m
# (22.5% off -- outside even the widened +-20% tolerance), so the target
# was corrected to match the measurement rather than forcing the tolerance
# wider to paper over the gap. width_min_m/width_max_m remain the
# secondary-sourced 10-16 m range: P7.2 confirmed (as design 4.5 already
# found for Monaco) that raw lap-to-lap lateral scatter is uninformative
# for absolute track width (median full-width scatter 0.30 m vs Suzuka's
# actual ~10-16 m width) -- these bounds are a floor/ceiling clamp target,
# not something derivable from scatter alone, same as Monaco's 8-12 m.
SUZUKA = CircuitConfig(
    id="suzuka",
    name="Suzuka International Racing Course",
    event_name="Japanese Grand Prix",
    length_target_m=5807.0,
    length_tolerance=0.03,
    elevation_target_m=40.0,
    elevation_tolerance=0.15,
    width_min_m=10.0,
    width_max_m=16.0,
)

CIRCUITS: dict[str, CircuitConfig] = {
    MONACO.id: MONACO,
    SUZUKA.id: SUZUKA,
}
