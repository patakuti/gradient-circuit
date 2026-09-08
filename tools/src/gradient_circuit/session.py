"""FastF1 session selection, loading and caching.

Design ref: 02_design.md section 4.1
"""

from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass
from pathlib import Path

import fastf1

CACHE_DIR = Path(__file__).resolve().parents[2] / ".fastf1cache"

# Number of past years to search when auto-selecting a session with usable
# position (telemetry) data for the requested event.
MAX_YEARS_BACK = 8


@dataclass(frozen=True)
class SessionSelection:
    year: int
    session_code: str  # e.g. "R"
    event_name: str
    session: fastf1.core.Session


def _ensure_cache() -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    fastf1.Cache.enable_cache(str(CACHE_DIR))


def _session_has_position_data(session: fastf1.core.Session) -> bool:
    """Return True if at least one lap has non-empty position telemetry."""
    try:
        session.load(laps=True, telemetry=True, weather=False, messages=False)
    except Exception:
        return False

    if session.laps is None or session.laps.empty:
        return False

    for _, lap in session.laps.iterlaps():
        try:
            pos = lap.get_pos_data()
        except Exception:
            continue
        if pos is not None and not pos.empty and len(pos) > 10:
            return True
    return False


def select_session(
    event_name: str, year: int | None = None, session_code: str = "R"
) -> SessionSelection:
    """Select a session for the given event with usable position data.

    If `year` is given, that year is used directly (no fallback search) so
    that results are reproducible when explicitly requested.
    Otherwise, search backwards from the current year for the most recent
    session of this event that has position telemetry available.
    """
    _ensure_cache()

    if year is not None:
        event = fastf1.get_event(year, event_name)
        session = event.get_session(session_code)
        if not _session_has_position_data(session):
            raise RuntimeError(
                f"No position data available for {event_name} {year} {session_code}"
            )
        return SessionSelection(year, session_code, event["EventName"], session)

    current_year = _dt.date.today().year
    errors: list[str] = []
    for candidate_year in range(current_year, current_year - MAX_YEARS_BACK, -1):
        try:
            event = fastf1.get_event(candidate_year, event_name)
        except Exception as exc:  # event not yet on calendar / not found
            errors.append(f"{candidate_year}: {exc}")
            continue

        try:
            session = event.get_session(session_code)
        except Exception as exc:
            errors.append(f"{candidate_year}: {exc}")
            continue

        if _session_has_position_data(session):
            return SessionSelection(
                candidate_year, session_code, event["EventName"], session
            )
        errors.append(f"{candidate_year}: no position data")

    raise RuntimeError(
        f"Could not find a {event_name} session with position data in the "
        f"last {MAX_YEARS_BACK} years. Details: " + "; ".join(errors)
    )
