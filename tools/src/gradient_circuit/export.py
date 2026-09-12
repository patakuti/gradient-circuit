"""JSON export in the `gradient-circuit/course@2` intermediate format.

Design ref: 02_design.md section 5.1. `@1` -> `@2` (P15): added the
`reference` block (design 4.8) with the fastest clean lap's speed profile.
"""

from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path

import numpy as np

SCHEMA = "gradient-circuit/course@2"
GENERATOR_VERSION = "0.1.0"


def build_course_document(
    *,
    name: str,
    event: str,
    year: int,
    session_code: str,
    laps_used: int,
    drivers_used: list[str],
    scale: float,
    bank_source: str,
    width_k: float,
    width_margin: float,
    s: np.ndarray,
    xyz: np.ndarray,
    width_left: np.ndarray,
    width_right: np.ndarray,
    curvature: np.ndarray,
    grade: np.ndarray,
    bank: np.ndarray,
    length: float,
    ds: float,
    reference_driver: str,
    reference_lap_number: float,
    reference_lap_time_s: float,
    reference_coverage: float,
    reference_speed: np.ndarray,
) -> dict:
    n = len(s)
    return {
        "schema": SCHEMA,
        "meta": {
            "name": name,
            "event": event,
            "year": year,
            "session": session_code,
            "source": "fastf1",
            "generated_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
            "generator_version": GENERATOR_VERSION,
            "laps_used": laps_used,
            "drivers_used": sorted(drivers_used),
            "scale": scale,
            "bank_source": bank_source,
            "width_calibration": {"k": width_k, "margin": width_margin},
        },
        "reference": {
            "driver": reference_driver,
            "lap_number": reference_lap_number,
            "lap_time_s": reference_lap_time_s,
            "coverage": reference_coverage,
            "speed": reference_speed.tolist(),
        },
        "units": {"length": "m", "angle": "rad"},
        "axes": {"up": "z", "handedness": "right"},
        "closed": True,
        "length": length,
        "ds": ds,
        "count": n,
        "samples": {
            "s": s.tolist(),
            "x": xyz[:, 0].tolist(),
            "y": xyz[:, 1].tolist(),
            "z": xyz[:, 2].tolist(),
            "widthLeft": width_left.tolist(),
            "widthRight": width_right.tolist(),
            "curvature": curvature.tolist(),
            "grade": grade.tolist(),
            "bank": bank.tolist(),
        },
    }


def write_course_json(doc: dict, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
