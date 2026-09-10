"""Centerline generation from clean laps.

Design ref: 02_design.md section 4.4

Pipeline:
1. Build a reference line from the fastest clean lap (scaled to meters),
   resampled to 1.0 m arc-length spacing.
2. Project every clean lap's points onto the reference line to get, for
   each point, a longitudinal position `s` and signed lateral offset `d`.
   Each lap is walked sequentially (a car cannot teleport within a lap),
   anchoring each point's search to a small window around the *previous*
   point's own resolved position, not a blind global nearest-XY search --
   see `project_laps`'s docstring for why (grade-separated crossovers,
   e.g. Suzuka's figure-eight). Points with |d| beyond MAX_PLAUSIBLE_OFFSET
   are rejected outright (see that constant's docstring): measured on the
   2026 Monaco GP race data, GPS position dropouts (e.g. in the tunnel)
   produce a smoothly-growing dead-reckoning drift reaching over 1000 m of
   apparent lateral offset in 19 of 80 clean laps -- these are not real
   driving lines and must not reach the median/percentile statistics below.
3. At each reference sample, take the median `d` and median `Z` across all
   laps that projected near it (robust to off-line excursions/contact).
4. Reconstruct the centerline as reference_line(s) + normal(s) * d_med(s)
   in the horizontal plane, with Z = Z_med(s).
5. Smooth Z at any *geometrically* self-crossing region
   (`smooth_self_crossing_regions`): wherever the reference line's own
   horizontal path proves two far-apart-in-`s` samples are physically
   stacked (a grade-separated crossover), replace Z there with smooth
   interpolation from the surroundings, at a stricter grade cap than
   step 5.1 below -- geometric detection doesn't depend on what the Z
   data happens to say, so it stays reliable exactly where per-lap/
   per-sample Z filters (tried and rejected -- see that function's
   docstring) aren't.
5.1. Replace any *remaining* run of samples with an implausible grade
   (`clip_implausible_grade`) via smooth interpolation from its trusted
   neighbors -- a general safety net for anywhere else on the course.
6. Smooth X, Y, Z with a periodic (wrap-boundary) Savitzky-Golay filter so
   the loop has no seam at the start/finish line.
7. Verify the loop closes (distance between the last and first sample is
   within one sample spacing).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.signal import savgol_filter
from scipy.spatial import cKDTree

from .laps import CleanLap

DS = 1.0  # target sample spacing [m], per design 4.4 step 2

# Savitzky-Golay defaults per design 4.4 step 6; window is in *samples*
# (samples are 1 m apart, so window=31 means a 31 m smoothing window).
#
# Originally 51 m. Revised down to 31 m (P12 follow-up, design 4.4/6.14
# addendum) after real play surfaced that the auto-drive assist wasn't
# taking a good line through Monaco's Piscine chicanes. Measured: the
# 51 m window was flattening real, if modest, lateral racing-line
# movement there (the median-of-all-laps position swings roughly +-1 m
# over that chicane) along with genuine GPS/aggregation noise. A window
# sweep (51/31/21/15/11/9/7) found 31 is as far as this can be narrowed
# without breaking acceptance criterion #5 (adjacent-sample curvature
# jump < 0.05 1/m) -- 21 already fails it course-wide (0.21), and windows
# below ~15 make the Savitzky-Golay fit itself numerically unstable on
# this noisy input (adjacent-jump blows up to double digits). 31 keeps a
# safety margin (measured max adjacent jump 0.036, course-wide) while
# retaining more of the real chicane movement than 51 did. This is a
# validated, measured improvement, not a full fix -- see design 4.4's
# addendum for what a proper fix (curvature-adaptive window) would need
# and why it was not attempted here.
DEFAULT_SG_WINDOW = 31
DEFAULT_SG_POLYORDER = 3

CLOSURE_TOLERANCE = DS  # design 4.4 step 7: gap must be < 1.0 m

# Reject projected lateral offsets beyond this magnitude before they reach
# any median/percentile aggregation. Measured on the 2026 Monaco GP race
# data: 96.1% of all projected points have |d| < 5 m, matching the real
# ~8-12 m track width; the remainder is a continuous tail up to 1227 m
# caused by GPS dropout dead-reckoning drift (see module docstring), not
# real driving. 12 m is a comfortable margin above design's own width-clamp
# half-width bound (7 m, section 4.5) -- no genuine on-track (or slightly
# off-line) point should exceed it, while the drift tail clearly does.
MAX_PLAUSIBLE_OFFSET = 12.0

# `project_laps` local search: once a point's search is anchored to a
# nearby known-good reference index (the previous point's own resolved
# position -- see that function's docstring), this margin is added on top
# of the step's actual Distance-channel delta to size the search window.
# Generous above plausible lateral deviation + per-step GPS/Distance noise
# (order of a few m between consecutive samples), while remaining far
# smaller than the arc-length gap between a course's self-crossing
# branches (~thousands of m) -- this is what makes the window immune to
# the crossover ambiguity that motivated it.
#
# A single per-lap constant alignment offset (course-s minus a lap's
# cumulative `Distance`) was tried and rejected: different laps take
# different racing lines through corners, so a lap's cumulative path
# length drifts from the reference line's arc length by tens of meters
# over the course of a lap (measured on real Suzuka data: up to ~25 m of
# drift within a single 200 m stretch, for a lap other than the one the
# reference line itself was built from) -- nowhere near precise enough to
# anchor a single lap-wide window against. Per-step sequential tracking
# sidesteps this: only the *local* Distance delta between consecutive
# samples needs to be accurate, and that holds regardless of a lap's
# overall racing line.
LOCAL_SEARCH_MARGIN_M = 15.0

# `clip_implausible_grade` (post-aggregation, applied to the candidate
# centerline's Z before smoothing): a run of adjacent samples whose
# implied grade exceeds this is replaced by smooth interpolation between
# its trusted neighbors. Measured normal grade elsewhere on real courses
# (2026 Monaco and Suzuka race data) stays within ~13% even at the
# steepest genuine elevation changes -- see that function's docstring for
# why this, not a per-lap or per-point filter, is what actually resolves
# the GPS-altitude-glitch problem at a course's grade-separated crossovers.
MAX_PLAUSIBLE_GRADE = 0.15


@dataclass
class RawCenterline:
    """Centerline before smoothing, with per-sample diagnostics."""

    s: np.ndarray  # (N,) cumulative distance [m]
    xyz: np.ndarray  # (N, 3) meters, Z-up
    tangent: np.ndarray  # (N, 3) unit
    normal: np.ndarray  # (N, 3) unit, horizontal, "left" of tangent
    d_lateral_all: list[np.ndarray]  # per-sample arrays of all projected d values (for width.py)
    length: float


def _cumulative_arclength(points: np.ndarray) -> np.ndarray:
    """3D cumulative arc length along an open polyline. points: (M,3)."""
    seg = np.linalg.norm(np.diff(points, axis=0), axis=1)
    return np.concatenate([[0.0], np.cumsum(seg)])


def _sample_count_for_closed_loop(total_length: float, ds: float) -> int:
    """Number of ds-spaced samples covering [0, total_length) such that the
    closing (wrap-around) gap is guaranteed to land in [0, ds).

    Using round(total_length/ds) does not guarantee this: the remainder
    total_length - round(total_length/ds)*ds can be negative, which pushes
    the actual wrap gap up to 1.5*ds. floor(...)+1 guarantees the gap is
    the true remainder in [0, ds) (design 4.4 step 7 / 5.2 invariant #4
    requires it to be < ds).
    """
    return int(np.floor(total_length / ds)) + 1


def _dedupe_monotonic(points: np.ndarray, order_key: np.ndarray) -> np.ndarray:
    """Sort by order_key and drop points that don't move the path forward
    (defensive against sensor glitches producing local reversals)."""
    idx = np.argsort(order_key, kind="stable")
    pts = points[idx]
    keep = [0]
    for i in range(1, len(pts)):
        if np.linalg.norm(pts[i] - pts[keep[-1]]) > 1e-6:
            keep.append(i)
    return pts[np.array(keep)]


def build_reference_line(fastest: CleanLap, scale: float) -> tuple[np.ndarray, np.ndarray]:
    """Build the 1 m-spaced reference line from the fastest clean lap.

    Returns (s, xyz) where s is (N,) and xyz is (N, 3) in meters.
    """
    raw = fastest.telemetry[["X", "Y", "Z"]].to_numpy(dtype=float) * scale
    order = fastest.telemetry["Distance"].to_numpy(dtype=float)
    pts = _dedupe_monotonic(raw, order)

    arclen = _cumulative_arclength(pts)
    total_length = float(arclen[-1])
    n_samples = _sample_count_for_closed_loop(total_length, DS)

    s_target = np.arange(n_samples) * DS
    xyz = np.empty((n_samples, 3))
    for axis in range(3):
        xyz[:, axis] = np.interp(s_target, arclen, pts[:, axis])
    return s_target, xyz


def compute_tangent_normal(xyz: np.ndarray, closed: bool = True) -> tuple[np.ndarray, np.ndarray]:
    """Central-difference tangent and horizontal left-normal at each sample.

    Sign convention: normal = rotate(tangent_xy, +90 deg). geometry.py's
    curvature sign is derived the same way, and that module's docstring
    documents how this was verified to match true left/right (via Monaco's
    known clockwise driving direction), not just internal self-consistency.
    """
    n = len(xyz)
    if closed:
        prev = np.roll(xyz, 1, axis=0)
        nxt = np.roll(xyz, -1, axis=0)
    else:
        prev = np.vstack([xyz[0], xyz[:-1]])
        nxt = np.vstack([xyz[1:], xyz[-1]])
    diff = nxt - prev
    tangent = diff / np.linalg.norm(diff, axis=1, keepdims=True)

    tx, ty = tangent[:, 0], tangent[:, 1]
    h_norm = np.hypot(tx, ty)
    h_norm = np.where(h_norm < 1e-9, 1.0, h_norm)
    fwd_x, fwd_y = tx / h_norm, ty / h_norm
    normal = np.zeros_like(tangent)
    normal[:, 0] = -fwd_y
    normal[:, 1] = fwd_x
    return tangent, normal


def _project_point_to_window(
    xy_point: np.ndarray, center_i: int, window_samples: int,
    ref_s: np.ndarray, ref_xyz: np.ndarray, ref_normal: np.ndarray,
) -> tuple[float, float]:
    """Nearest-segment projection of one XY point, searching only reference
    segments within `window_samples` of `center_i` (periodic wrap). Returns
    (s, signed lateral offset d)."""
    n = len(ref_s)
    length = ref_s[-1] + DS
    best_d, best_s, best_dist2 = None, None, None
    for offset in range(-window_samples, window_samples + 1):
        a = (center_i + offset) % n
        b = (a + 1) % n
        seg_vec = ref_xyz[b, :2] - ref_xyz[a, :2]
        seg_len2 = float(seg_vec @ seg_vec)
        if seg_len2 < 1e-9:
            continue
        t = float((xy_point - ref_xyz[a, :2]) @ seg_vec / seg_len2)
        t = min(1.0, max(0.0, t))
        proj = ref_xyz[a, :2] + t * seg_vec
        delta = xy_point - proj
        dist2 = float(delta @ delta)
        if best_dist2 is None or dist2 < best_dist2:
            best_dist2 = dist2
            if a == n - 1 and b == 0:
                best_s = (ref_s[a] + t * DS) % length
            else:
                best_s = ref_s[a] + t * (ref_s[b] - ref_s[a])
            best_d = float(delta @ ref_normal[a, :2])
    assert best_d is not None and best_s is not None  # window_samples >= 0 always yields >=1 segment
    return best_s, best_d


def walk_lap_projection(
    xy: np.ndarray, dist: np.ndarray, ref_s: np.ndarray, ref_xyz: np.ndarray, ref_normal: np.ndarray,
    tree: cKDTree,
):
    """Sequentially project one lap's (already scaled) XY points onto the
    reference line, yielding `(point_index, anchor_i, best_d)` for every
    point that resolves within `MAX_PLAUSIBLE_OFFSET`.

    This is the lap-continuity walking algorithm documented on
    `project_laps` below, extracted so it exists in exactly one place.
    `project_laps` uses it to bucket `d`/`Z` (design 4.4); `gripfit.py`
    (design 4.9) uses the same walk to bucket `d`/`Speed` for the grip-model
    fit, without duplicating the crossover-safe anchoring logic.
    """
    n = len(ref_s)
    margin_samples = max(1, int(round(LOCAL_SEARCH_MARGIN_M / DS)))

    anchor_i: int | None = None
    anchor_dist: float | None = None
    for pi in range(len(xy)):
        if anchor_i is None:
            _, i0 = tree.query(xy[pi])
            center_i = int(i0)
            window_samples = margin_samples
        else:
            step = abs(dist[pi] - anchor_dist)
            window_samples = max(1, int(round(step / DS)) + margin_samples)
            center_i = anchor_i

        best_s, best_d = _project_point_to_window(
            xy[pi], center_i, window_samples, ref_s, ref_xyz, ref_normal,
        )

        if abs(best_d) > MAX_PLAUSIBLE_OFFSET:
            continue  # anchor unchanged; next step's window widens accordingly

        anchor_i = int(round(best_s / DS)) % n
        anchor_dist = dist[pi]

        yield pi, anchor_i, best_d


def project_laps(
    laps: list[CleanLap], scale: float, ref_s: np.ndarray, ref_xyz: np.ndarray, ref_normal: np.ndarray
) -> tuple[list[list[float]], list[list[float]]]:
    """Project every point of every lap onto the reference line.

    Matching a point to a reference sample by nearest XY distance alone is
    ambiguous wherever two different parts of the course pass close
    together in the horizontal plane but are actually far apart along the
    course (different `s`) -- e.g. Suzuka's grade-separated figure-eight
    crossover, where the upper and lower levels are only ~10-20 m apart in
    XY. A point genuinely on one level can end up nearest, in XY, to a
    reference sample on the *other* level, contaminating that sample's
    z_buckets/d_buckets with the wrong level's elevation (measured: up to
    ~20 m of spurious spread in a single 1 m bucket at Suzuka's crossovers,
    producing a physically impossible +-30% grade wiggle in the exported
    course after aggregation -- not just noise, since XY-only matching
    reliably prefers the wrong branch there, not a random mix).

    Instead, each lap is walked sequentially, in telemetry order (a car
    cannot teleport within a lap):
    1. The lap's first point uses an unconstrained global nearest-XY
       search (as before). This is safe: every clean lap starts and ends
       at the start/finish line (by definition of "lap"), never at a
       mid-lap crossover.
    2. Every subsequent point searches only within a window around the
       *previous point's own resolved index*, sized by
       LOCAL_SEARCH_MARGIN_M plus that step's actual FastF1 `Distance`
       delta (meters, monotonic within one lap, independent of the X/Y/Z
       unit question -- see scale.py) -- a window far too narrow to ever
       reach the course's other, spatially-close-but-arc-length-distant
       branch.
    3. A step whose best match still exceeds MAX_PLAUSIBLE_OFFSET does not
       update the anchor -- its Distance delta simply accumulates into the
       next step's window -- so one bad/dropped point can't permanently
       derail the rest of the lap's tracking.

    Elevation is *not* filtered here at all -- neither per point nor per
    lap. GPS altitude glitches near a course's grade-separated crossovers
    turned out not to be reliably separable from genuine (if steep) real
    transitions by looking at any single point, lap, or even a per-sample
    majority vote across laps: at one of Suzuka's two crossovers, which
    lap-cluster is the "majority" genuinely flips as `s` crosses the real
    transition, so per-sample filtering (by any of: a lap's own running Z,
    the reference lap's Z, or a per-sample trimmed median) either misses a
    sustained wrong block or turns a real gradual transition into an
    erratic, sample-by-sample flip. The fix that actually works operates
    after aggregation instead -- see `clip_implausible_grade`.

    Returns (d_buckets, z_buckets): each is a list of length len(ref_s),
    where d_buckets[i] / z_buckets[i] hold the lateral offset / elevation
    values (meters) of all lap points that projected nearest to sample i,
    paired index-for-index.
    """
    n = len(ref_s)
    tree = cKDTree(ref_xyz[:, :2])
    d_buckets: list[list[float]] = [[] for _ in range(n)]
    z_buckets: list[list[float]] = [[] for _ in range(n)]

    for lap in laps:
        pts = lap.telemetry[["X", "Y", "Z"]].to_numpy(dtype=float) * scale
        dist = lap.telemetry["Distance"].to_numpy(dtype=float)

        for pi, anchor_i, best_d in walk_lap_projection(pts[:, :2], dist, ref_s, ref_xyz, ref_normal, tree):
            d_buckets[anchor_i].append(best_d)
            z_buckets[anchor_i].append(float(pts[pi, 2]))

    return d_buckets, z_buckets


def aggregate_centerline(
    ref_s: np.ndarray, ref_xyz: np.ndarray, ref_normal: np.ndarray,
    d_buckets: list[list[float]], z_buckets: list[list[float]],
) -> np.ndarray:
    """Reconstruct centerline candidate points via median d / Z per sample
    (robust to off-line excursions/contact and to a minority of GPS
    glitches, given enough contributing laps). See `clip_implausible_grade`
    for the remaining, harder case: a course location where which lap-
    cluster is the majority genuinely flips as `s` varies.
    """
    n = len(ref_s)
    out = np.empty((n, 3))
    for i in range(n):
        d_med = float(np.median(d_buckets[i])) if d_buckets[i] else 0.0
        z_med = float(np.median(z_buckets[i])) if z_buckets[i] else float(ref_xyz[i, 2])
        out[i, 0] = ref_xyz[i, 0] + ref_normal[i, 0] * d_med
        out[i, 1] = ref_xyz[i, 1] + ref_normal[i, 1] * d_med
        out[i, 2] = z_med
    return out


def _smooth_flagged_runs(z: np.ndarray, bad_sample: np.ndarray, max_grade: float) -> np.ndarray:
    """Shared expansion+interpolation engine for both `clip_implausible_grade`
    and `smooth_self_crossing_regions`: replace each contiguous (periodic)
    run of `bad_sample` indices with linear interpolation between trusted
    neighbors just outside it, expanding those neighbors further out first
    if a straight line between them would *itself* still exceed `max_grade`
    (picking the immediate neighbors of a short flagged run is not enough
    when the real height difference across it is large -- measured on real
    Suzuka data, an abrupt ~6 m jump over just 1-2 samples; a short
    interpolation across that is just as steep as the original)."""
    n = len(z)
    if not np.any(bad_sample):
        return z

    def periodic_span(lo: int, hi: int) -> int:
        d = (hi - lo) % n
        return d if d != 0 else n

    out = z.copy()
    visited = np.zeros(n, dtype=bool)
    for start in range(n):
        if not bad_sample[start] or visited[start]:
            continue
        end = start
        while bad_sample[(end + 1) % n] and not visited[(end + 1) % n]:
            end = (end + 1) % n
            if end == start:
                break  # the whole course is flagged; nothing sane to interpolate from
        lo = (start - 1) % n
        hi = (end + 1) % n
        if lo == hi:
            continue  # degenerate: no trusted neighbor outside the run

        toggle = 0
        while periodic_span(lo, hi) * DS * max_grade + 1e-9 < abs(z[hi] - z[lo]):
            if periodic_span(lo, hi) >= n - 1:
                break  # nearly the whole course; give up expanding further
            if toggle % 2 == 0:
                hi = (hi + 1) % n
            else:
                lo = (lo - 1) % n
            toggle += 1

        idx = []
        i = (lo + 1) % n
        while i != hi:
            idx.append(i)
            visited[i] = True
            i = (i + 1) % n
        visited[lo] = True
        visited[hi] = True
        run_len = len(idx)
        if run_len == 0:
            continue
        for k, i in enumerate(idx):
            t = (k + 1) / (run_len + 1)
            out[i] = (1.0 - t) * z[lo] + t * z[hi]
    return out


def clip_implausible_grade(xyz: np.ndarray, max_grade: float = MAX_PLAUSIBLE_GRADE) -> np.ndarray:
    """Replace any run of samples whose adjacent-sample grade exceeds
    `max_grade` with smooth linear interpolation between its trusted
    neighbors (periodic). `xyz` must be sampled at uniform DS spacing
    (true of the reference line this runs on, before reparameterize_uniform).

    General safety net (catches an implausible grade *wherever* it shows
    up), kept alongside the more targeted `smooth_self_crossing_regions`:
    see that function's docstring for why a course's grade-separated
    crossovers specifically need geometric detection, not just a grade
    threshold, to look right. Measured: normal grade stays within ~13%
    even at the steepest genuine elevation changes on both Monaco and
    Suzuka.
    """
    n = len(xyz)
    z = xyz[:, 2]
    # `s` is uniformly DS apart by construction (this runs on the reference
    # line's own arc-length grid, before reparameterize_uniform) -- DS is a
    # fine approximation even for the one closing step, which is within
    # [0, DS) of it by design (see _sample_count_for_closed_loop).
    grade = np.abs(np.diff(z, append=z[0])) / DS
    bad = grade > max_grade
    if not np.any(bad):
        return xyz
    # Grow each bad *step* (i -> i+1) into a bad *sample* mask so both
    # endpoints of an implausible step are candidates for replacement.
    bad_sample = bad | np.roll(bad, 1)
    out = xyz.copy()
    out[:, 2] = _smooth_flagged_runs(z, bad_sample, max_grade)
    return out


def find_self_crossing_regions(
    ref_xyz: np.ndarray, min_s_gap_m: float = 800.0, close_xy_m: float = 60.0,
) -> np.ndarray:
    """Geometrically locate where the course's own horizontal path passes
    close to a *different, far-away-in-s* part of itself -- a grade-
    separated crossover (bridge/underpass), regardless of what its Z data
    looks like. Returns a boolean mask over `ref_xyz`'s samples.

    `min_s_gap_m` excludes ordinary tight corners (e.g. a hairpin's own
    entry and exit lanes legitimately run close together over a much
    smaller arc-length gap than a real course-spanning crossover -- 800 m
    comfortably clears that while still catching a real crossover, whose
    two arms are typically thousands of m apart in `s`).
    """
    n = len(ref_xyz)
    min_gap_samples = int(round(min_s_gap_m / DS))
    tree = cKDTree(ref_xyz[:, :2])
    # k=8 is plenty of nearby-in-XY candidates to find one far away in s;
    # a real crossover's other level is the dominant close match there.
    dist, idx = tree.query(ref_xyz[:, :2], k=8)

    mask = np.zeros(n, dtype=bool)
    for i in range(n):
        for k in range(1, dist.shape[1]):
            j = int(idx[i, k])
            if min(abs(i - j), n - abs(i - j)) < min_gap_samples:
                continue
            if dist[i, k] < close_xy_m:
                mask[i] = True
            break
    return mask


def smooth_self_crossing_regions(
    ref_xyz: np.ndarray, xyz: np.ndarray, max_grade: float = 0.08,
    min_s_gap_m: float = 800.0, close_xy_m: float = 60.0,
) -> np.ndarray:
    """Replace Z at geometrically-detected self-crossing regions (see
    `find_self_crossing_regions`) with smooth interpolation from their
    surroundings, at a stricter grade cap than `clip_implausible_grade`'s
    general safety net.

    Motivation (measured on real 2026 Suzuka race data, at one of its two
    grade-separated crossovers): no per-lap or per-sample filter in
    `project_laps`/`aggregate_centerline` reliably distinguishes a real
    elevation transition from GPS-altitude contamination there, because
    which lap-cluster is the majority genuinely flips from one 1 m sample
    to the next across the transition -- not a single lap being wrong the
    whole time, but the *dominant cluster itself* changing underfoot.
    Filtering per-point or per-lap either misses a sustained wrong block
    or turns a real transition into an erratic flip. A plain grade
    threshold on the aggregated result (`clip_implausible_grade`) does
    catch the worst of it, but can still leave a locally-plausible-looking
    (just under the cap) transition that is visibly wrong compared to a
    real reference elevation profile, which shows crossovers as part of a
    long, gentle trend, not a compressed dip. Geometric detection sidesteps
    all of that: it doesn't care what the Z data says, only where the
    course's own plan-view path proves two unrelated `s` ranges must be
    physically stacked -- so it can be smoothed with a deliberately
    stricter cap without risking a false positive elsewhere on the course.
    """
    mask = find_self_crossing_regions(ref_xyz, min_s_gap_m, close_xy_m)
    if not np.any(mask):
        return xyz
    out = xyz.copy()
    out[:, 2] = _smooth_flagged_runs(xyz[:, 2], mask, max_grade)
    return out


def smooth_periodic(xyz: np.ndarray, window: int, polyorder: int) -> np.ndarray:
    out = np.empty_like(xyz)
    for axis in range(3):
        out[:, axis] = savgol_filter(xyz[:, axis], window, polyorder, mode="wrap")
    return out


def closure_error(xyz: np.ndarray) -> float:
    return float(np.linalg.norm(xyz[-1] - xyz[0]))


def reparameterize_uniform(xyz: np.ndarray, ds: float = DS) -> tuple[np.ndarray, np.ndarray]:
    """Resample a closed, periodic polyline to exactly uniform arc-length
    spacing (design 5.2 invariant #3).

    Savitzky-Golay smoothing perturbs point positions slightly, which can
    leave adjacent-sample spacing a few percent off `ds` even though the
    pre-smoothing samples were exactly uniform. Measured on real data: up
    to ~17% of samples exceeded the 1% tolerance (max 34% / 0.34 m) before
    this step. Re-deriving the true cumulative arc length of the smoothed
    curve (including its closing segment) and re-interpolating at exact
    multiples of `ds` removes that drift entirely.
    """
    closed_pts = np.vstack([xyz, xyz[:1]])  # append start point to close the loop
    arclen = _cumulative_arclength(closed_pts)
    total_length = float(arclen[-1])
    n_samples = _sample_count_for_closed_loop(total_length, ds)

    s_target = np.arange(n_samples) * ds
    out = np.empty((n_samples, 3))
    for axis in range(3):
        out[:, axis] = np.interp(s_target, arclen, closed_pts[:, axis])
    return s_target, out


def generate_centerline(
    clean_laps: list[CleanLap],
    fastest: CleanLap,
    scale: float,
    sg_window: int = DEFAULT_SG_WINDOW,
    sg_polyorder: int = DEFAULT_SG_POLYORDER,
) -> dict:
    """Run the full centerline pipeline. Returns a dict of arrays/diagnostics."""
    ref_s, ref_xyz = build_reference_line(fastest, scale)
    _, ref_normal = compute_tangent_normal(ref_xyz, closed=True)

    d_buckets, z_buckets = project_laps(clean_laps, scale, ref_s, ref_xyz, ref_normal)
    candidate = aggregate_centerline(ref_s, ref_xyz, ref_normal, d_buckets, z_buckets)
    # Geometric self-crossing detection first (targeted, stricter cap --
    # see smooth_self_crossing_regions), then the general safety net for
    # anything implausible elsewhere.
    candidate = smooth_self_crossing_regions(ref_xyz, candidate)
    candidate = clip_implausible_grade(candidate)
    smoothed = smooth_periodic(candidate, sg_window, sg_polyorder)
    # Savitzky-Golay can reintroduce a little overshoot right at the edge
    # of a sharp correction (ordinary filter ringing); a second pass here
    # catches that residue without needing a wider first-pass correction.
    smoothed = smooth_self_crossing_regions(ref_xyz, smoothed)
    smoothed = clip_implausible_grade(smoothed)
    final_s, final_xyz = reparameterize_uniform(smoothed, DS)

    gap = closure_error(final_xyz)

    return {
        "s": final_s,
        "xyz": final_xyz,
        "xyz_presmooth": candidate,
        "xyz_smoothed_preresample": smoothed,
        "ref_s": ref_s,
        "ref_xyz": ref_xyz,
        # d_buckets/z_buckets are indexed by `ref_s`, NOT `final_s`: they are
        # built during projection, before reparameterize_uniform changes the
        # sample count (measured: 3285 vs 3271 on real data -- these two
        # grids are close but not identical). Anything derived from them
        # (e.g. width.py's per-sample arrays) must be interpolated from
        # `ref_s` onto `final_s`/`s` before being exported alongside x/y/z;
        # see cli.py.
        "d_buckets": d_buckets,
        "z_buckets": z_buckets,
        "closure_gap": gap,
        "length": float(final_s[-1] + DS),
    }
