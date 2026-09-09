/**
 * Vehicle longitudinal dynamics: a pure function stepping speed and
 * along-track distance forward by one fixed timestep.
 *
 * Design ref: 02_design.md section 6.3. No `three` import (enforced by
 * eslint.config.js) -- kept engine-agnostic like sim/track.ts.
 *
 * Scope (requirements 4.2): acceleration, braking and a curvature-based
 * cornering speed limit. Still no steering -- `lateralOffset` stays 0.
 */

export interface VehicleParams {
  mass: number; // [kg]
  maxPower: number; // [W] drive-force cap that dominates at high speed
  maxTractionForce: number; // [N] drive-force cap that dominates at low speed
  maxBrakeForce: number; // [N] braking deceleration force cap
  maxLateralAccel: number; // [m/s^2] cornering grip limit (lateral)
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
 * uphill positive, design 4.6/6.3) and `curvature` the signed curvature
 * (design 4.6/6.2), both sampled by the caller at the vehicle's *current*
 * position before calling this function (design 6.4).
 *
 * Cornering speed limit: rather than hard-clamping speed to the
 * curvature-implied safe speed, the excess is converted into an extra
 * deceleration force (`F_corner`, design 6.3) so it composes with the rest
 * of the force-based model instead of causing a speed discontinuity.
 * `maxLateralAccel` is chosen larger than both `maxTractionForce` and
 * `maxBrakeForce` (design 6.3, sim/vehicleParams.ts) so this cap always
 * wins even under full throttle.
 */
export function stepVehicle(
  state: VehicleState,
  throttle: number,
  brake: number,
  grade: number,
  curvature: number,
  dt: number,
  params: VehicleParams,
  trackLength: number,
): VehicleState {
  const clampedThrottle = Math.max(0, Math.min(1, throttle));
  const clampedBrake = Math.max(0, Math.min(1, brake));

  const speedForPower = Math.max(state.speed, 1.0);
  const driveForceLimit = Math.min(params.maxTractionForce, params.maxPower / speedForPower);
  const driveForce = clampedThrottle * driveForceLimit;
  const brakeForce = clampedBrake * params.maxBrakeForce;
  const dragForce = params.dragFactor * state.speed * state.speed;
  const rollForce = params.rollingResistance;
  const gravForce = params.mass * params.gravity * Math.sin(grade);

  const cornerSpeedLimit =
    curvature === 0 ? Infinity : Math.sqrt(params.maxLateralAccel / Math.abs(curvature));
  const cornerForce = state.speed > cornerSpeedLimit ? params.mass * params.maxLateralAccel : 0;

  const accel =
    (driveForce - brakeForce - dragForce - rollForce - gravForce - cornerForce) / params.mass;
  const speed = Math.max(0, state.speed + accel * dt);

  let s = state.s + speed * dt;
  let lap = state.lap;
  while (s >= trackLength) {
    s -= trackLength;
    lap += 1;
  }

  return { s, speed, lap, lateralOffset: state.lateralOffset };
}
