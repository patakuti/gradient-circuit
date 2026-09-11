"""Grip-model fit from real telemetry.

Design ref: 02_design.md section 4.9. Plan ref: 03_plan.md P12.0.

This is not a course-data generation step -- it does not touch
course/<id>.json. Its output (`a0`, `k`, `a_cap` below) is a measurement
used to set `web/src/sim/vehicleParams.ts`'s speed-dependent grip constants
(`mechLateralAccel` / `aeroLateralCoeff` / `maxLateralAccelCap`, design
6.3.2), replacing the constant `maxLateralAccel` the vehicle model used
through P8-P11.

Why a speed-dependent model at all (not a constant): a car's usable
cornering grip rises with speed because aerodynamic downforce grows with
v^2, then plateaus because tire grip has diminishing returns under rising
vertical load. A single constant cannot represent both a slow hairpin and a
fast sweeper correctly at once -- see the module's preliminary measurement
in design 4.9 for the magnitude (measured ~15-23% error at the tightest
corners under a constant model).

Method:
1. Project every clean lap's telemetry point onto the *exported* course
   centerline (the same `x`/`y`/`z`/`curvature` the simulator will query at
   runtime -- not a freshly rebuilt, unsmoothed reference line) via
   `centerline.walk_lap_projection`, pairing each point's real `Speed`
   with the course's `curvature` at that `s`.
2. a_lat = v^2 * |curvature| at every projected point.
3. Bin by speed; take the p95 envelope per bin (design 4.9: the envelope,
   not the median, approximates "the limit of grip used", since drivers
   spend most of a lap below their maximum available grip).
4. Fit `a = a0 + k * v^2` by ordinary least squares over the *rising* part
   of the envelope (bins up to and including the speed where the envelope
   peaks) -- the flat/declining tail beyond the peak is tire-load
   saturation, not more grip, and would bias a fit over the full range
   toward underestimating `k`.
5. `a_cap` is the highest envelope value observed at or beyond that peak:
   the model is capped at what a real car actually achieved, never an
   unobserved extrapolation.

Samples from every circuit are pooled before fitting (design 4.9: "the car
is one car" -- the coefficients are a vehicle property, not a per-circuit
one).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from .centerline import compute_tangent_normal, walk_lap_projection
from .laps import CleanLap

# Speed-bin width for the envelope (design 4.9's illustrative table used
# ~40-60 km/h bands; 10 m/s = 36 km/h is in that range and gives enough
# bins across a 0-90 m/s range to resolve the rise-then-plateau shape).
SPEED_BIN_WIDTH_MPS = 10.0

# A bin needs at least this many projected points for its p95 to be a
# meaningful envelope estimate rather than noise from a handful of samples.
MIN_BIN_SAMPLES = 30

ENVELOPE_PERCENTILE = 95

# "Tightest corners" comparison (mirrors design 4.9's preliminary table):
# the fraction of curvature samples, by magnitude, treated as "tight".
TIGHTEST_CORNER_FRACTION = 0.05


@dataclass(frozen=True)
class CourseRef:
    """The subset of an exported course.json needed to project telemetry
    onto it: the same centerline/curvature the simulator queries at
    runtime (design 4.9 -- deliberately not a freshly rebuilt reference
    line, so the fit matches what actually gets driven on)."""

    id: str
    ref_s: np.ndarray  # (N,) [m]
    ref_xyz: np.ndarray  # (N, 3) [m], Z-up
    ref_normal: np.ndarray  # (N, 3) horizontal left-normal
    curvature: np.ndarray  # (N,) [1/m]
    length: float


def load_course_ref(course_json_path: Path) -> CourseRef:
    doc = json.loads(course_json_path.read_text(encoding="utf-8"))
    sm = doc["samples"]
    ref_s = np.asarray(sm["s"], dtype=float)
    ref_xyz = np.column_stack([sm["x"], sm["y"], sm["z"]]).astype(float)
    curvature = np.asarray(sm["curvature"], dtype=float)
    _, ref_normal = compute_tangent_normal(ref_xyz, closed=True)
    return CourseRef(
        id=doc["meta"]["name"], ref_s=ref_s, ref_xyz=ref_xyz, ref_normal=ref_normal,
        curvature=curvature, length=float(doc["length"]),
    )


@dataclass(frozen=True)
class ProjectedPoints:
    """Every telemetry point of a circuit's clean laps that projected onto
    its course, paired with the course sample it landed on. Kept as three
    parallel arrays (not a combined a_lat column) so both the speed/a_lat
    envelope fit and the per-corner real-vs-model comparison can be derived
    from the same projection pass without re-walking the laps."""

    speed_mps: np.ndarray  # (M,)
    anchor_i: np.ndarray  # (M,) index into the course's curvature array


def project_clean_laps(clean_laps: list[CleanLap], scale: float, course: CourseRef) -> ProjectedPoints:
    tree = cKDTree(course.ref_xyz[:, :2])
    speeds: list[float] = []
    anchors: list[int] = []

    for lap in clean_laps:
        pts = lap.telemetry[["X", "Y"]].to_numpy(dtype=float) * scale
        dist = lap.telemetry["Distance"].to_numpy(dtype=float)
        speed_kmh = lap.telemetry["Speed"].to_numpy(dtype=float)

        for pi, anchor_i, _best_d in walk_lap_projection(
            pts, dist, course.ref_s, course.ref_xyz, course.ref_normal, tree,
        ):
            speeds.append(speed_kmh[pi] / 3.6)
            anchors.append(anchor_i)

    return ProjectedPoints(speed_mps=np.asarray(speeds), anchor_i=np.asarray(anchors, dtype=int))


def lateral_accel_samples(points: ProjectedPoints, course: CourseRef) -> np.ndarray:
    """(M, 2) array of [speed_mps, a_lat] -- a_lat = v^2 * |curvature| at
    the course sample each point projected onto."""
    kappa = np.abs(course.curvature[points.anchor_i])
    a_lat = points.speed_mps**2 * kappa
    return np.column_stack([points.speed_mps, a_lat])


def speed_bin_envelope(
    samples: np.ndarray, bin_width: float = SPEED_BIN_WIDTH_MPS, min_samples: int = MIN_BIN_SAMPLES,
    percentile: float = ENVELOPE_PERCENTILE,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Bin `samples` (columns [speed_mps, a_lat]) by speed and return
    (v_mid, a_envelope, n) for bins with at least `min_samples` points."""
    v, a = samples[:, 0], samples[:, 1]
    if len(v) == 0:
        return np.array([]), np.array([]), np.array([])
    n_bins = int(np.ceil(v.max() / bin_width)) + 1
    edges = np.arange(n_bins + 1) * bin_width
    idx = np.digitize(v, edges) - 1

    v_mid: list[float] = []
    a_env: list[float] = []
    counts: list[int] = []
    for b in range(n_bins):
        mask = idx == b
        count = int(mask.sum())
        if count < min_samples:
            continue
        v_mid.append(edges[b] + bin_width / 2)
        a_env.append(float(np.percentile(a[mask], percentile)))
        counts.append(count)

    return np.asarray(v_mid), np.asarray(a_env), np.asarray(counts)


@dataclass(frozen=True)
class GripFit:
    a0: float  # mechanical grip at v=0 [m/s^2]
    k: float  # aero coefficient [1/m]
    a_cap: float  # saturation cap [m/s^2]
    peak_bin_index: int  # index into v_mid/a_env where the rising fit stopped


def fit_grip_curve(v_mid: np.ndarray, a_env: np.ndarray) -> GripFit:
    """Fit a0 + k*v^2 to the rising part of the envelope, up to (but
    excluding) its peak bin, and take a_cap from the peak/plateau tail.

    The peak bin itself is excluded from the quadratic fit, not included:
    the peak is where saturation *starts*, so it already sits on the flat
    part, not the quadratic. Including it pulls the fit toward the
    saturated value and biases a0/k. See module docstring step 4-5."""
    if len(v_mid) < 2:
        raise ValueError("need at least 2 populated speed bins to fit a grip curve")

    peak_i = int(np.argmax(a_env))
    rise_n = min(max(peak_i, 2), len(v_mid))
    v_rise = v_mid[:rise_n]
    a_rise = a_env[:rise_n]

    design = np.column_stack([np.ones_like(v_rise), v_rise**2])
    coef, *_ = np.linalg.lstsq(design, a_rise, rcond=None)
    a0, k = float(coef[0]), float(coef[1])

    a_cap = float(np.max(a_env[peak_i:]))
    # The fit must not predict, anywhere within the rising range actually
    # used to fit it, a value above the cap -- that would make the
    # piecewise model min(a0+k*v^2, a_cap) saturate *before* reaching data
    # the fit itself says is still on the rise, an internal inconsistency.
    # (Beyond the rise range -- e.g. at the peak's own speed -- the fit is
    # expected to overshoot the cap; that overshoot is exactly what
    # saturation means and must not widen the cap.) Only a small/noisy bin
    # count should ever trigger this.
    fit_rise_max = float(np.max(a0 + k * v_rise**2))
    a_cap = max(a_cap, fit_rise_max)

    return GripFit(a0=a0, k=k, a_cap=a_cap, peak_bin_index=peak_i)


def lateral_grip_at(speed_mps: np.ndarray | float, fit: GripFit) -> np.ndarray | float:
    """The speed-dependent grip model itself: min(a0 + k*v^2, a_cap)."""
    return np.minimum(fit.a0 + fit.k * np.asarray(speed_mps) ** 2, fit.a_cap)


@dataclass(frozen=True)
class TightCornerReport:
    threshold_kappa: float
    n_points: int
    real_speed_p50_kmh: float
    model_speed_p50_kmh: float
    ratio_p50: float  # real / model -- < 1 means the model allows more speed than the real car used


def tightest_corner_report(
    points: ProjectedPoints, course: CourseRef, fit: GripFit, top_fraction: float = TIGHTEST_CORNER_FRACTION,
) -> TightCornerReport | None:
    """Real speed vs. the fit's speed limit, restricted to points that
    projected onto the tightest `top_fraction` of the course's curvature
    samples. Mirrors design 4.9's preliminary-measurement table so the
    real fit can be checked against it."""
    kappa_all = np.abs(course.curvature)
    nonzero = kappa_all[kappa_all > 0]
    if len(nonzero) == 0:
        return None
    threshold = float(np.percentile(nonzero, 100 - top_fraction * 100))

    point_kappa = kappa_all[points.anchor_i]
    mask = point_kappa >= threshold
    if not mask.any():
        return None

    v_real = points.speed_mps[mask]
    a_max = lateral_grip_at(v_real, fit)
    v_model = np.sqrt(a_max / np.maximum(point_kappa[mask], 1e-9))

    return TightCornerReport(
        threshold_kappa=threshold, n_points=int(mask.sum()),
        real_speed_p50_kmh=float(np.median(v_real)) * 3.6,
        model_speed_p50_kmh=float(np.median(v_model)) * 3.6,
        ratio_p50=float(np.median(v_real / v_model)),
    )


@dataclass(frozen=True)
class CircuitGripData:
    course: CourseRef
    clean_laps: list[CleanLap]
    scale: float


@dataclass(frozen=True)
class GripFitReport:
    fit: GripFit
    v_mid: np.ndarray
    a_env: np.ndarray
    counts: np.ndarray
    n_samples_total: int
    per_circuit_tight_corner: dict[str, TightCornerReport | None]


def fit_pooled_grip_model(circuits: dict[str, CircuitGripData]) -> GripFitReport:
    """Collect samples from every circuit, pool them for the fit, then
    separately report each circuit's tightest-corner real-vs-model ratio
    (design 4.9: coefficients are pooled/shared, but the sanity check is
    reported per circuit so a single circuit's projection quirks don't
    hide in an aggregate)."""
    per_circuit_points: dict[str, ProjectedPoints] = {}
    all_samples = []
    for circuit_id, data in circuits.items():
        points = project_clean_laps(data.clean_laps, data.scale, data.course)
        per_circuit_points[circuit_id] = points
        all_samples.append(lateral_accel_samples(points, data.course))

    pooled = np.concatenate(all_samples, axis=0)
    v_mid, a_env, counts = speed_bin_envelope(pooled)
    fit = fit_grip_curve(v_mid, a_env)

    per_circuit_tight = {
        circuit_id: tightest_corner_report(per_circuit_points[circuit_id], circuits[circuit_id].course, fit)
        for circuit_id in circuits
    }

    return GripFitReport(
        fit=fit, v_mid=v_mid, a_env=a_env, counts=counts, n_samples_total=len(pooled),
        per_circuit_tight_corner=per_circuit_tight,
    )
