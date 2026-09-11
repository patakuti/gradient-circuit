/**
 * Automatic-follow driving assist (requirement 4.2.4, design 6.14).
 *
 * Computes the steering/braking a capable driver would apply, so the
 * "auto" drive mode can complete a lap hands-off without changing
 * sim/vehicle.ts's physics at all (design 6.14.1) -- its output is fed
 * into VehicleInput through the exact same path a human's keyboard input
 * takes (main.ts's mixInput, design 6.14.4), so it is subject to the same
 * steer-rate ramp and grip limits as manual play. This keeps mode
 * switching structurally glitch-free: there is only ever one steer state
 * (VehicleState.steer), and the mode only changes where its target comes
 * from.
 *
 * "assist" mode (P12 follow-up, design 6.14.1a) reuses this same output --
 * main.ts blends it into the driver's own steer/brake input instead of
 * replacing it. No separate control law lives here for that mode.
 */

import type { Track } from "./track";
import type { SurfaceState, VehicleParams, VehicleState } from "./vehicle";
import { maxSteerAngleAt } from "./vehicle";

export type DriveMode = "auto" | "assist" | "manual";

export interface AssistOutput {
  steer: number; // [-1, 1], same command space as VehicleInput.steer
  brake: number; // [0, 1]
  throttleCut: boolean; // true while braking -- main.ts should drop driver throttle
}

// Steering gains (design 6.14.2). Derived, not tuned: linearizing the
// Frenet lateral-error dynamics under kappa = kappaFF - K_D*d - K_PSI*psi
// gives d'' + speed*K_PSI*d' + speed^2*K_D*d = 0, i.e. wn = speed*sqrt(K_D)
// and zeta = K_PSI/(2*sqrt(K_D)) -- notably speed-independent. These pick
// critical damping (zeta = 1). Real steer-rate limiting (design 6.3.7) is
// not part of this linearization, so the in-browser P12.3 drive test is
// still what confirms there's no mushiness/oscillation in practice.
const K_D = 0.01; // 1/m^2
const K_PSI = 0.2; // 1/m
const PREVIEW_TIME_S = 0.5; // s, feedforward lookahead -- outruns steerRate's own lag
const PREVIEW_MIN_M = 5; // m, floor so lookahead doesn't collapse to 0 at low/zero speed

// Caps the `d` fed into K_D before it reaches kappaTarget (design 6.14.1a,
// P12 follow-up for "assist" mode's large-offset recovery). The
// critical-damping derivation above assumes the achieved curvature tracks
// kappaTarget; in reality both maxSteerAngleAt() and stepVehicle's grip
// limiting cap what curvature is actually achievable, and for large |d|,
// K_D*d alone already exceeds that cap -- so the whole kappaTarget sum
// saturates regardless of K_PSI*psi, masking the heading-feedback damping
// term until |d| shrinks back down. By then psi has built up far past
// what the linearization assumes, so the car swings past centerline and
// re-saturates the other way. Measured directly (not guessed) by running
// this module's own computeAssist + sim/vehicle.ts's stepVehicle
// headlessly from a 15 m offset: uncapped, this doesn't just overshoot
// once, it grows (15 -> -33 -> +44 m on Monaco's real track at 40 m/s) and
// never recovers at 60-80 m/s. Sweeping DAMPING_D_CAP against speeds
// 20-90 m/s and offsets 2-15 m, 2.0 m was the largest value with zero
// sign flips (monotonic recovery, no oscillation) at every point tested;
// 3.0 m already re-diverges at 80 m/s (maxSteerAngleAt shrinks to ~2.9 deg
// there, leaving very little authority once K_D*d is that large). This
// only ever engages during recovery -- within normal driving |d| stays
// well under 2 m, so it's a no-op for existing "auto" behavior.
const DAMPING_D_CAP = 2.0; // m

// Braking lookahead (design 6.14.3).
const CORNER_MARGIN = 0.85; // fraction of lateral grip the assist targets, leaving a margin for error
// fraction of braking force the assist uses. Lower than CORNER_MARGIN's
// symmetric 0.85 counterpart on purpose: an in-browser sweep (P12.3) found
// Monaco's Grand Hotel Hairpin (curvature ~0.12-0.15, the tightest corner
// on either course) briefly pushes past the road edge under full-throttle
// auto driving at 0.8 (measured excess 1.10 m); lowering this margin cuts
// that excess, at a lap-time cost, with no measurable effect on Suzuka
// (which never approaches its own edges). Steer-rate was swept too and
// had no effect on the excess -- confirming this is a braking margin
// issue, not a steering-lag one. Re-measured and re-tuned after the P1
// course-generation smoothing window changed (design 4.4, 51m -> 31m,
// to stop flattening real chicane movement): the narrower window made
// the hairpin's approach curvature a little more demanding, pushing the
// excess at the old 0.65 back up to 1.16 m. 0.45 brings it down to
// 0.86 m for a further ~1.5 s lap-time cost (Monaco: 76.7 -> 79.9 s).
// The residual ~0.86 m at this one corner is a known limit of a simple
// margin-based controller at the tightest curve in either course; P13
// (surface/wall) should watch for it.
const BRAKE_MARGIN = 0.45;
const BRAKE_BAND_MPS = 3; // speed above target over which brake ramps 0->1, avoiding an on/off step
const SCAN_STEP_M = 1; // matches track.ds (design 6.14.3): worst case ~500 samples/step, cheap

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * The lateral-grip-limited speed for curvature `kappa` on a surface with
 * `gripFactor`, including CORNER_MARGIN and the maxLateralAccelCap
 * saturation (design 6.14.3's closed-form solve for v in
 * `v^2*kappa = lateralGripAt(v)*gripFactor*CORNER_MARGIN`).
 *
 * This reads the same VehicleParams fields sim/vehicle.ts's lateralGripAt
 * does, rather than calling it, because inverting "grip as a function of
 * speed" into "speed as a function of curvature" needs the coefficients
 * themselves, not just an evaluation -- but since it's the same three
 * fields, the two can't silently drift apart (a rename breaks both).
 */
function cornerGripSpeed(kappa: number, gripFactor: number, params: VehicleParams): number {
  const absKappa = Math.abs(kappa);
  if (absKappa < 1e-9) return Infinity;

  const scale = gripFactor * CORNER_MARGIN;
  const aEff0 = params.mechLateralAccel * scale;
  const kEff = params.aeroLateralCoeff * scale;
  const aCapEff = params.maxLateralAccelCap * scale;

  // Unsaturated branch: v^2*kappa = aEff0 + kEff*v^2 -> v^2 = aEff0/(kappa-kEff).
  // If kEff >= kappa, downforce grows at least as fast as demand and the
  // unsaturated model alone would never be grip-limited -- the cap is what
  // actually binds, so fall through to it below.
  let v = absKappa > kEff ? Math.sqrt(aEff0 / (absKappa - kEff)) : Infinity;

  // If the unsaturated solution implies more grip than the cap allows,
  // saturation kicked in before reaching it -- the real crossing point is
  // where the capped (constant) grip alone balances the curvature demand.
  if (v === Infinity || v * v * absKappa > aCapEff) {
    v = Math.sqrt(aCapEff / absKappa);
  }
  return v;
}

/**
 * Computes one step's automatic-follow input. Pure function; main.ts
 * calls it only while the active drive mode is "auto" (design 6.14.5) and
 * feeds the result through the same input path a human's keys take.
 */
export function computeAssist(
  track: Track,
  state: VehicleState,
  params: VehicleParams,
  surface: SurfaceState,
): AssistOutput {
  // --- Steering: preview feedforward + lateral/heading-error feedback (design 6.14.2) ---
  const previewDistance = Math.max(PREVIEW_MIN_M, state.speed * PREVIEW_TIME_S);
  const previewCurvature = track.sampleAt(state.s + previewDistance).curvature;
  const dampingD = clamp(state.lateralOffset, -DAMPING_D_CAP, DAMPING_D_CAP);
  const kappaTarget = previewCurvature - K_D * dampingD - K_PSI * state.yaw;
  const delta = Math.atan(kappaTarget * params.wheelBase);
  const steerRange = maxSteerAngleAt(state.speed, params);
  const steer = steerRange > 1e-9 ? clamp(delta / steerRange, -1, 1) : 0;

  // --- Braking: scan ahead for the slowest upcoming corner reachable
  // under braking (design 6.14.3). Target speed is grip-limited only in
  // P12 -- P14 replaces cornerGripSpeed's result here with
  // min(referenceSpeed, cornerGripSpeed(...)) once course data carries a
  // measured reference speed profile. ---
  const aBrake = (params.maxBrakeForce * surface.gripFactor * BRAKE_MARGIN) / params.mass;
  const horizon = (state.speed * state.speed) / (2 * Math.max(aBrake, 1e-6)) + PREVIEW_MIN_M;

  let vTarget = Infinity;
  for (let ds = 0; ds <= horizon; ds += SCAN_STEP_M) {
    const sample = track.sampleAt(state.s + ds);
    const vPoint = cornerGripSpeed(sample.curvature, surface.gripFactor, params);
    vTarget = Math.min(vTarget, Math.sqrt(vPoint * vPoint + 2 * aBrake * ds));
  }

  const brake = clamp((state.speed - vTarget) / BRAKE_BAND_MPS, 0, 1);
  return { steer, brake, throttleCut: brake > 0 };
}
