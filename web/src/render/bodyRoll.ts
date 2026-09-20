/**
 * Display-only body roll (design 6.8.2). Pure functions, no `three` or
 * `sim/` imports -- main.ts computes every value passed in (design 6.1).
 *
 * Sign convention: positive roll = the car's left side rises (leans right).
 * With `Object3D.lookAt` (+Z forward, +Y up, so +X is the car's left),
 * that is exactly `rotateZ(+roll)`.
 */

const DEG = Math.PI / 180;

// Feel-tuned placeholders, adjusted by real-play confirmation (design 6.8.2).
const ROLL_PER_G = 0.7 * DEG; // [rad/g] lean toward the outside of the turn
const CURB_ROLL = 3 * DEG; // [rad] lift on the side that's on the curb
const MAX_ROLL = 7 * DEG; // [rad] total cap
const ROLL_TIME_CONSTANT_S = 0.1; // [s] keeps the angle from jumping on curb entry/exit
const GRAVITY = 9.81; // [m/s^2] only converts lateral acceleration into g

/**
 * @param lateralAccel [m/s^2], positive = left turn (sim/vehicle.ts's `lateralAccel`)
 * @param lateralOffset [m], positive = left of the centerline
 * @param onCurb whether the car is currently on a curb band
 */
export function targetBodyRoll(lateralAccel: number, lateralOffset: number, onCurb: boolean): number {
  // Left turn (lateralAccel > 0) leans the body right = left side up = +roll.
  const rollG = ROLL_PER_G * (lateralAccel / GRAVITY);
  // On a left curb (offset > 0) the left wheels ride up = left side up = +roll.
  const rollCurb = onCurb ? Math.sign(lateralOffset) * CURB_ROLL : 0;
  return Math.min(MAX_ROLL, Math.max(-MAX_ROLL, rollG + rollCurb));
}

/** Frame-rate-independent exponential approach of `current` toward `target`. */
export function smoothRoll(current: number, target: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-dt / ROLL_TIME_CONSTANT_S));
}
