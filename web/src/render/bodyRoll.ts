/**
 * Display-only body roll (design 6.8.2). Pure functions, no `three` or
 * `sim/` imports -- main.ts computes every value passed in (design 6.1).
 *
 * Two separate rolls, since they move different parts of the car (P25):
 * - chassis roll (lateral G): only the sprung body leans, around the roll
 *   center; the wheels stay planted and upright.
 * - curb roll: the whole car, wheels included, tilts around the contact
 *   line of the wheels that are *not* on the curb, so those stay on the road.
 *
 * Sign convention: positive roll = the car's left side rises (leans right).
 * With `Object3D.lookAt` (+Z forward, +Y up, so +X is the car's left),
 * that is exactly `rotateZ(+roll)`.
 */

const DEG = Math.PI / 180;

// Feel-tuned placeholders, adjusted by real-play confirmation (design 6.8.2).
const ROLL_PER_G = 0.7 * DEG; // [rad/g] lean toward the outside of the turn
const MAX_CHASSIS_ROLL = 5 * DEG; // [rad] cap on the lateral-G lean
const CURB_ROLL = 3 * DEG; // [rad] lift on the side that's on the curb
const ROLL_TIME_CONSTANT_S = 0.1; // [s] keeps the angle from jumping on curb entry/exit
const GRAVITY = 9.81; // [m/s^2] only converts lateral acceleration into g

/**
 * Chassis-only lean from lateral G.
 * @param lateralAccel [m/s^2], positive = left turn (sim/vehicle.ts's `lateralAccel`)
 */
export function targetChassisRoll(lateralAccel: number): number {
  // Left turn (lateralAccel > 0) leans the body right = left side up = +roll.
  const roll = ROLL_PER_G * (lateralAccel / GRAVITY);
  return Math.min(MAX_CHASSIS_ROLL, Math.max(-MAX_CHASSIS_ROLL, roll));
}

/**
 * Whole-car tilt from riding a curb.
 * @param leftOnCurb whether the left-hand wheels are on a curb band
 * @param rightOnCurb whether the right-hand wheels are on a curb band
 */
export function targetCurbRoll(leftOnCurb: boolean, rightOnCurb: boolean): number {
  // Wheels riding up on a curb lift that side: left = +roll, right = -roll
  // (both sides on curbs cancel out).
  return ((leftOnCurb ? 1 : 0) - (rightOnCurb ? 1 : 0)) * CURB_ROLL;
}

/**
 * Local X of the curb roll's pivot: the contact line of the side that stays
 * down. Flips side only as `curbRoll` passes through 0, so the car's
 * position stays continuous while the angle is smoothed.
 * @param wheelTrackHalf [m] centerline-to-wheel distance (sim/vehicleParams.ts)
 */
export function curbRollPivotX(curbRoll: number, wheelTrackHalf: number): number {
  return curbRoll > 0 ? -wheelTrackHalf : wheelTrackHalf;
}

/** Frame-rate-independent exponential approach of `current` toward `target`. */
export function smoothRoll(current: number, target: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-dt / ROLL_TIME_CONSTANT_S));
}
