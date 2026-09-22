/**
 * Off-course surface model: which road-edge band the vehicle's current
 * lateral offset falls in, and the grip/rolling multipliers + wall
 * boundary that follow from it (design 6.13). Three.js-independent, like
 * sim/vehicle.ts and sim/track.ts.
 *
 * render/barrier.ts and render/circuitScenery.ts read `barrierOffsetAt()`/
 * `bandWidth()` from here too, so the visible edge (curb/grass/wall) and
 * the physical one stepVehicle() stops the car at can never drift apart
 * (design 6.13.3, acceptance criterion #19).
 */

import type { CourseFeature, CourseKind } from "../course/catalog";
import type { TrackSample } from "./track";
import type { SurfaceState } from "./vehicle";

export type SurfaceKind = "asphalt" | "curb" | "grass" | "wall";

/** A band of off-road surface, from the paved edge outward. */
export interface SurfaceBand {
  kind: Exclude<SurfaceKind, "wall">;
  width: number; // [m]
  gripFactor: number; // [-] 1.0 = asphalt
  rollingFactor: number; // [-] 1.0 = asphalt
}

/**
 * The one "curb" band, shared by every course that has curbs at all:
 * Suzuka's full-circuit curb (design 6.13.2) and Monaco's per-corner curb
 * zones (design 6.13.5, P27). Exported so render/circuitScenery.ts and
 * render/cityScenery.ts can size their curb ribbons from this single
 * source instead of a second hardcoded copy (design 6.12's "don't
 * double-maintain band widths" rule).
 */
export const CURB_BAND: SurfaceBand = { kind: "curb", width: 0.6, gripFactor: 0.85, rollingFactor: 1.5 };

/**
 * Extra clearance beyond Monaco's curb, before the wall (design 6.13.5
 * follow-up, P27). Plain asphalt grip -- a run-off apron, not part of the
 * curb itself. Without it, a car using the *full* width of a 0.6 m curb
 * would already have its outer edge at the wall: CURB_BAND.width (0.6 m)
 * is less than vehicleParams.ts's vehicleHalfWidth (0.95 m), so
 * stepVehicle's wall-contact clamp (design 6.3.5) would engage -- and
 * start scrubbing speed -- before the curb was used up, making the curb
 * impossible to lean on with any margin (user report: "縁石を攻められな
 * い"). Sized past vehicleHalfWidth with room to spare, not just enough to
 * clear it, so there's slack rather than a new limit right at the edge.
 * Doesn't apply on `circuit` (Suzuka): its wall already sits 6 m of grass
 * past the curb (SURFACE_LAYOUT.circuit below), far more than this needs.
 * A tuning value (same status as CORNER_MARGIN etc., design 6.3.7/6.14.3),
 * pending real-play confirmation.
 */
const CURB_RUNOFF_BAND: SurfaceBand = { kind: "asphalt", width: 1.5, gripFactor: 1, rollingFactor: 1 };

/**
 * Band layout per course kind (design 6.13.2, requirement 4.7.2/4.7.3).
 * `street` (Monaco) has no runoff by default -- the wall sits right at the
 * paved edge, matching the real circuit -- except within the per-corner
 * curb zones handled by `bandsAt()` below (design 6.13.5, P27). `circuit`
 * (Suzuka) reuses the widths P11's render/circuitScenery.ts originally
 * hardcoded (design 6.13.2). Grip/rolling values are tuning constants
 * pending real-play confirmation (same status as sim/vehicleParams.ts's
 * steering constants, design 6.3.7).
 */
export const SURFACE_LAYOUT: Record<CourseKind, SurfaceBand[]> = {
  street: [],
  circuit: [CURB_BAND, { kind: "grass", width: 6.0, gripFactor: 0.35, rollingFactor: 4.0 }],
};

function totalBandWidth(bands: SurfaceBand[]): number {
  return bands.reduce((sum, band) => sum + band.width, 0);
}

/**
 * The band layout to use at this specific point (design 6.13.5, P27).
 * `circuit` always uses its fixed layout. `street` uses its default (no
 * runoff) unless `sample.s` falls inside a `curb`-type CourseFeature that
 * applies to `side` (a feature with no `side` applies to both), in which
 * case the curb band plus its run-off band apply before the wall. Reads
 * the feature's `sStart`/`sEnd` as given -- course/catalog.ts's Monaco
 * entries already bake in the corner-exit extension (design 6.13.5
 * follow-up, P27) so this stays the single source both the physics here
 * and render/cityScenery.ts's visible curb ribbon read from, and the two
 * can't drift apart (design 6.12's rule).
 */
function bandsAt(
  courseKind: CourseKind,
  sample: TrackSample,
  side: "left" | "right",
  curbFeatures: CourseFeature[],
): SurfaceBand[] {
  if (courseKind !== "street") return SURFACE_LAYOUT[courseKind];
  const onCurb = curbFeatures.some(
    (f) => f.type === "curb" && sample.s >= f.sStart && sample.s < f.sEnd && (f.side === undefined || f.side === side),
  );
  return onCurb ? [CURB_BAND, CURB_RUNOFF_BAND] : SURFACE_LAYOUT.street;
}

/**
 * Width of one named band for a course kind (0 if that course has none,
 * e.g. "curb" on a `street` course). Lets render/circuitScenery.ts share
 * the exact widths sim/vehicle.ts's grip model uses instead of keeping a
 * second hardcoded copy.
 */
export function bandWidth(courseKind: CourseKind, kind: Exclude<SurfaceKind, "wall">): number {
  return SURFACE_LAYOUT[courseKind].find((band) => band.kind === kind)?.width ?? 0;
}

export interface SurfaceQuery extends SurfaceState {
  kind: SurfaceKind;
}

/**
 * The offset from centerline, on `side`, where the wall sits: the paved
 * half-width plus every band's width. render/barrier.ts draws its ribbon
 * at exactly this value. `curbFeatures` (design 6.13.5, P27, default []):
 * course/catalog.ts's `curb`-type CourseFeatures, so the wall steps outward
 * by the curb's width within a curb zone -- see bandsAt() above.
 */
export function barrierOffsetAt(
  courseKind: CourseKind,
  sample: TrackSample,
  side: "left" | "right",
  curbFeatures: CourseFeature[] = [],
): number {
  const half = side === "left" ? sample.widthLeft : sample.widthRight;
  return half + totalBandWidth(bandsAt(courseKind, sample, side, curbFeatures));
}

/**
 * The surface under a single point at `lateralOffset` on `sample`
 * (design 6.13.1). wheelSurfaceAt() below calls this once per wheel side.
 * `curbFeatures`: see barrierOffsetAt() above.
 */
export function surfaceAt(
  courseKind: CourseKind,
  sample: TrackSample,
  lateralOffset: number,
  curbFeatures: CourseFeature[] = [],
): SurfaceQuery {
  const side: "left" | "right" = lateralOffset >= 0 ? "left" : "right";
  const half = side === "left" ? sample.widthLeft : sample.widthRight;
  const bands = bandsAt(courseKind, sample, side, curbFeatures);
  const maxLateralOffset = half + totalBandWidth(bands);
  let excess = Math.abs(lateralOffset) - half;

  if (excess <= 0) {
    return { kind: "asphalt", gripFactor: 1, rollingFactor: 1, maxLateralOffset };
  }
  for (const band of bands) {
    if (excess <= band.width) {
      return { kind: band.kind, gripFactor: band.gripFactor, rollingFactor: band.rollingFactor, maxLateralOffset };
    }
    excess -= band.width;
  }
  // Past every band (or immediately, where no band applies): pinned at the
  // wall. gripFactor/rollingFactor mirror asphalt -- stepVehicle's own
  // wall-contact physics (design 6.3.5), not this multiplier, is what
  // actually stops and slows the car, so there's no separate "wall grip"
  // to tune here.
  return { kind: "wall", gripFactor: 1, rollingFactor: 1, maxLateralOffset };
}

/** Both sides' surfaces plus the combined values stepVehicle needs (design 6.13.1, P23). */
export interface WheelSurfaceQuery extends SurfaceState {
  kind: SurfaceKind; // the worse of the two wheels (wall > grass > curb > asphalt), for the HUD
  leftKind: SurfaceKind; // surface under the left-hand wheels (+d side)
  rightKind: SurfaceKind; // surface under the right-hand wheels (-d side)
}

const SURFACE_SEVERITY: Record<SurfaceKind, number> = { asphalt: 0, curb: 1, grass: 2, wall: 3 };

/**
 * The surface under each side's wheels, judged separately (design 6.13.1,
 * P23): a car straddling the road edge has one side on the curb/grass and
 * the other still on asphalt. Grip/rolling are the mean of the two sides
 * (each side carries half the load); the wall boundary stays the center
 * point's own `maxLateralOffset`, since stepVehicle already offsets the
 * wall stop by vehicleHalfWidth (design 6.3.5).
 */
export function wheelSurfaceAt(
  courseKind: CourseKind,
  sample: TrackSample,
  lateralOffset: number,
  wheelTrackHalf: number,
  curbFeatures: CourseFeature[] = [],
): WheelSurfaceQuery {
  const left = surfaceAt(courseKind, sample, lateralOffset + wheelTrackHalf, curbFeatures);
  const right = surfaceAt(courseKind, sample, lateralOffset - wheelTrackHalf, curbFeatures);
  const center = surfaceAt(courseKind, sample, lateralOffset, curbFeatures);
  return {
    kind: SURFACE_SEVERITY[left.kind] >= SURFACE_SEVERITY[right.kind] ? left.kind : right.kind,
    leftKind: left.kind,
    rightKind: right.kind,
    gripFactor: (left.gripFactor + right.gripFactor) / 2,
    rollingFactor: (left.rollingFactor + right.rollingFactor) / 2,
    maxLateralOffset: center.maxLateralOffset,
  };
}
