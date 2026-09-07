/**
 * Vehicle longitudinal dynamics: a pure function stepping speed and
 * along-track distance forward by one fixed timestep.
 *
 * Design ref: 02_design.md section 6.3. No `three` import (enforced by
 * eslint.config.js) -- kept engine-agnostic like sim/track.ts.
 *
 * Scope (requirements 4.2): acceleration/deceleration only. No braking, no
 * cornering speed limit, no steering. `throttle = 0` still decelerates the
 * car via drag, rolling resistance and uphill grade.
 */

export interface VehicleParams {
  mass: number; // [kg]
  maxPower: number; // [W] drive-force cap that dominates at high speed
  maxTractionForce: number; // [N] drive-force cap that dominates at low speed
  dragFactor: number; // [N/(m/s)^2] = 0.5 * rho * Cd * A
  rollingResistance: number; // [N]
  gravity: number; // [m/s^2]
}

export interface VehicleState {
  s: number; // distance along the course [m]
  speed: number; // [m/s], non-negative
  lap: number; // completed lap count
  lateralOffset: number; // reserved for future steering, always 0 for now
}

/**
 * Advances `state` by `dt` seconds. `grade` is the track grade (radians,
 * uphill positive, design 4.6/6.3) at the vehicle's *current* position,
 * sampled by the caller before calling this function (design 6.4).
 */
export function stepVehicle(
  state: VehicleState,
  throttle: number,
  grade: number,
  dt: number,
  params: VehicleParams,
  trackLength: number,
): VehicleState {
  const clampedThrottle = Math.max(0, Math.min(1, throttle));

  const speedForPower = Math.max(state.speed, 1.0);
  const driveForceLimit = Math.min(params.maxTractionForce, params.maxPower / speedForPower);
  const driveForce = clampedThrottle * driveForceLimit;
  const dragForce = params.dragFactor * state.speed * state.speed;
  const rollForce = params.rollingResistance;
  const gravForce = params.mass * params.gravity * Math.sin(grade);

  const accel = (driveForce - dragForce - rollForce - gravForce) / params.mass;
  const speed = Math.max(0, state.speed + accel * dt);

  let s = state.s + speed * dt;
  let lap = state.lap;
  while (s >= trackLength) {
    s -= trackLength;
    lap += 1;
  }

  return { s, speed, lap, lateralOffset: state.lateralOffset };
}
