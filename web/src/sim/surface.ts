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

import type { CourseKind } from "../course/catalog";
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
 * Band layout per course kind (design 6.13.2, requirement 4.7.2/4.7.3).
 * `street` (Monaco) has no runoff -- the wall sits right at the paved
 * edge, matching the real circuit. `circuit` (Suzuka) reuses the widths
 * P11's render/circuitScenery.ts originally hardcoded (design 6.13.2).
 * Grip/rolling values are tuning constants pending real-play confirmation
 * (same status as sim/vehicleParams.ts's steering constants, design 6.3.7).
 */
export const SURFACE_LAYOUT: Record<CourseKind, SurfaceBand[]> = {
  street: [],
  circuit: [
    { kind: "curb", width: 0.6, gripFactor: 0.85, rollingFactor: 1.5 },
    { kind: "grass", width: 6.0, gripFactor: 0.35, rollingFactor: 4.0 },
  ],
};

function totalBandWidth(courseKind: CourseKind): number {
  return SURFACE_LAYOUT[courseKind].reduce((sum, band) => sum + band.width, 0);
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
 * at exactly this value.
 */
export function barrierOffsetAt(courseKind: CourseKind, sample: TrackSample, side: "left" | "right"): number {
  const half = side === "left" ? sample.widthLeft : sample.widthRight;
  return half + totalBandWidth(courseKind);
}

/**
 * The surface at `lateralOffset` on `sample` (design 6.13.1). Treats the
 * vehicle as a point (no per-wheel surface split) -- requirement 4.7
 * doesn't ask for per-contact-patch behavior, and it would need a second
 * point sample every physics step for little benefit.
 */
export function surfaceAt(courseKind: CourseKind, sample: TrackSample, lateralOffset: number): SurfaceQuery {
  const half = lateralOffset >= 0 ? sample.widthLeft : sample.widthRight;
  const maxLateralOffset = half + totalBandWidth(courseKind);
  let excess = Math.abs(lateralOffset) - half;

  if (excess <= 0) {
    return { kind: "asphalt", gripFactor: 1, rollingFactor: 1, maxLateralOffset };
  }
  for (const band of SURFACE_LAYOUT[courseKind]) {
    if (excess <= band.width) {
      return { kind: band.kind, gripFactor: band.gripFactor, rollingFactor: band.rollingFactor, maxLateralOffset };
    }
    excess -= band.width;
  }
  // Past every band (or immediately, for `street`'s empty layout): pinned
  // at the wall. gripFactor/rollingFactor mirror asphalt -- stepVehicle's
  // own wall-contact physics (design 6.3.5), not this multiplier, is what
  // actually stops and slows the car, so there's no separate "wall grip"
  // to tune here.
  return { kind: "wall", gripFactor: 1, rollingFactor: 1, maxLateralOffset };
}
