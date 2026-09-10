/**
 * Vehicle dynamics: a pure function stepping speed, along-track distance,
 * lateral offset and yaw forward by one fixed timestep.
 *
 * Design ref: 02_design.md section 6.3. No `three` import (enforced by
 * eslint.config.js) -- kept engine-agnostic like sim/track.ts.
 *
 * Scope (requirements 4.2): acceleration, braking, and a kinematic-bicycle
 * steering model on Frenet (s, d, yaw) coordinates (design 6.3.1). Grip
 * limits are speed-dependent (design 4.9) and steering overshoot is
 * expressed as understeer (design 6.3.3), not an automatic speed cap --
 * P8's cornerSpeedLimit()/F_corner are gone.
 */

export interface VehicleParams {
  mass: number; // [kg]
  maxPower: number; // [W] drive-force cap that dominates at high speed
  maxTractionForce: number; // [N] drive-force cap that dominates at low speed
  maxBrakeForce: number; // [N] braking deceleration force cap
  dragFactor: number; // [N/(m/s)^2] = 0.5 * rho * Cd * A
  rollingResistance: number; // [N]
  gravity: number; // [m/s^2]

  // Speed-dependent lateral grip (design 4.9, fit from real telemetry --
  // see sim/vehicleParams.ts for the measured values and methodology):
  // lateralGripAt(v) = min(mechLateralAccel + aeroLateralCoeff * v^2, maxLateralAccelCap)
  mechLateralAccel: number; // [m/s^2] a0: mechanical grip at v=0
  aeroLateralCoeff: number; // [1/m] k: downforce term
  maxLateralAccelCap: number; // [m/s^2] tire load-sensitivity ceiling

  // Steering (design 6.3.2/6.3.7):
  wheelBase: number; // [m]
  maxSteerAngle: number; // [rad] low-speed geometric max steer angle
  steerRate: number; // [1/s] how fast the steer command rises toward input while held
  steerReturnRate: number; // [1/s] how fast it self-centers when released
  steerGripFactor: number; // [-] how much of lateralGripAt(v) full lock may demand
  maxYaw: number; // [rad] hard cap on |yaw|, structurally rules out spin/reverse (requirement 2.2)
}

export interface VehicleState {
  s: number; // distance along the course [m]
  speed: number; // [m/s], non-negative. Forward speed of the car body (design 6.3.1)
  lap: number; // completed lap count
  lateralOffset: number; // d [m]: signed offset from the centerline, positive = left (sim/track.ts normal sign)
  yaw: number; // psi [rad]: heading relative to the track tangent, positive = left
  steer: number; // current normalized steer command [-1, 1], positive = left
}

/** One step's input. */
export interface VehicleInput {
  throttle: number; // [0, 1]
  brake: number; // [0, 1]
  steer: number; // [-1, 1] commanded value (not the steer angle itself -- see steerToCurvature)
}

/** The road surface the vehicle currently sits on (design 6.13's surfaceAt()
 * supplies this at runtime; P12 passes a fixed asphalt value until P13). */
export interface SurfaceState {
  gripFactor: number; // [-] multiplier on 1.0 = asphalt, applied to both longitudinal and lateral grip
  rollingFactor: number; // [-] multiplier on rolling resistance
  maxLateralOffset: number; // [m] |d| beyond which the vehicle is stopped by a wall (design 6.3.5)
}

export const ASPHALT_SURFACE: SurfaceState = { gripFactor: 1, rollingFactor: 1, maxLateralOffset: Infinity };

export interface VehicleStepResult {
  state: VehicleState;
  gripExceeded: boolean; // true while the requested turn exceeds the grip limit (understeer, design 6.3.3)
  wallContact: boolean; // true while the vehicle is being held at a wall boundary (design 6.3.5)
}

/**
 * Speed-dependent lateral grip limit (design 4.9/6.3.2): mechanical grip
 * plus a downforce term that grows with v^2, capped by tire load
 * sensitivity. Shared by the vehicle model itself, the max-steer-angle
 * calculation (design 6.3.4) and the autopilot's braking lookahead
 * (design 6.14.3) so the limit is computed in exactly one place.
 */
export function lateralGripAt(speed: number, params: VehicleParams): number {
  return Math.min(
    params.mechLateralAccel + params.aeroLateralCoeff * speed * speed,
    params.maxLateralAccelCap,
  );
}

/**
 * Speed-dependent max steer angle (design 6.3.4): full lock may only
 * demand `steerGripFactor` times the available grip. `steerGripFactor`
 * must exceed 1 or steering alone could never exceed the grip limit,
 * which would make the "understeer when overdriven" behavior (design
 * 6.3.3) unreachable from the steering side.
 *
 * Exported (not just used internally) because sim/autopilot.ts's steering
 * controller (design 6.14.2) needs to convert a target steer *angle* back
 * into the same normalized [-1, 1] command space stepVehicle expects, and
 * must use the exact same speed-dependent scale to do so.
 */
export function maxSteerAngleAt(speed: number, params: VehicleParams): number {
  const v = Math.max(speed, 1);
  const geometric = Math.atan((params.wheelBase * params.steerGripFactor * lateralGripAt(speed, params)) / (v * v));
  return Math.min(params.maxSteerAngle, geometric);
}

/**
 * The path curvature the current steer command demands, before any grip
 * limiting (design 6.3.2). Exported so callers (e.g. debug HUD) can read
 * the same value the model itself uses without duplicating the formula.
 */
export function steerToCurvature(steer: number, speed: number, params: VehicleParams): number {
  const delta = steer * maxSteerAngleAt(speed, params);
  return Math.tan(delta) / params.wheelBase;
}

function moveToward(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(current + maxDelta, target);
  if (current > target) return Math.max(current - maxDelta, target);
  return current;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Advances `state` by `dt` seconds. `grade`/`curvature` are the track's
 * grade (radians, uphill positive) and signed curvature at the vehicle's
 * *current* position, sampled by the caller before calling this function
 * (design 6.4). `surface` carries the road-surface grip/rolling
 * multipliers and wall boundary (design 6.13; pass ASPHALT_SURFACE until
 * P13 wires up sim/surface.ts).
 */
export function stepVehicle(
  state: VehicleState,
  input: VehicleInput,
  grade: number,
  curvature: number,
  surface: SurfaceState,
  dt: number,
  params: VehicleParams,
  trackLength: number,
): VehicleStepResult {
  const clampedThrottle = clamp(input.throttle, 0, 1);
  const clampedBrake = clamp(input.brake, 0, 1);
  const clampedSteerInput = clamp(input.steer, -1, 1);

  // --- Longitudinal (design 6.3.3) ---
  const speedForPower = Math.max(state.speed, 1.0);
  const driveForceLimit = Math.min(params.maxTractionForce, params.maxPower / speedForPower);
  const driveForce = clampedThrottle * driveForceLimit * surface.gripFactor;
  const brakeForce = clampedBrake * params.maxBrakeForce * surface.gripFactor;
  const dragForce = params.dragFactor * state.speed * state.speed;
  const rollForce = params.rollingResistance * surface.rollingFactor;
  const gravForce = params.mass * params.gravity * Math.sin(grade);

  const accel = (driveForce - brakeForce - dragForce - rollForce - gravForce) / params.mass;
  const speed = Math.max(0, state.speed + accel * dt);

  // --- Steering: analog steer command (requirement 4.2.2) ---
  const returning = clampedSteerInput === 0;
  const steerRate = returning ? params.steerReturnRate : params.steerRate;
  const steer = moveToward(state.steer, clampedSteerInput, steerRate * dt);

  // --- Understeer when the demanded turn exceeds grip (design 6.3.3) ---
  const kappaDemand = steerToCurvature(steer, speed, params);
  const aMax = lateralGripAt(speed, params) * surface.gripFactor;
  const speedSq = Math.max(speed * speed, 1e-6);
  const aDemand = speedSq * Math.abs(kappaDemand);
  const gripExceeded = aDemand > aMax;
  const kappaCar = gripExceeded ? Math.sign(kappaDemand) * (aMax / speedSq) : kappaDemand;

  // --- Frenet update (design 6.3.3; the 1/(1 - curvature*d) term is
  // deliberately dropped -- see design 6.3.3's "known approximation" for why) ---
  let yaw = clamp(state.yaw + speed * (kappaCar - curvature) * dt, -params.maxYaw, params.maxYaw);
  let lateralOffset = state.lateralOffset + speed * Math.sin(yaw) * dt;
  let speedAfterWall = speed;
  let wallContact = false;

  // --- Wall contact (design 6.3.5): project the velocity onto the wall
  // direction instead of an arbitrary deceleration constant -- a shallow
  // contact angle barely slows the car, a steep one sheds most of its speed. ---
  if (Math.abs(lateralOffset) > surface.maxLateralOffset) {
    lateralOffset = clamp(lateralOffset, -surface.maxLateralOffset, surface.maxLateralOffset);
    speedAfterWall = speed * Math.abs(Math.cos(yaw)) * WALL_FRICTION_FACTOR;
    yaw = 0;
    wallContact = true;
  }

  // s never decreases: speedAfterWall >= 0 and |yaw| <= maxYaw < 90deg keep
  // cos(yaw) > 0 always, so requirement 2.2's "no spin/reverse" holds
  // structurally -- no backward-wrap case to handle here.
  let s = state.s + speedAfterWall * Math.cos(yaw) * dt;
  let lap = state.lap;
  while (s >= trackLength) {
    s -= trackLength;
    lap += 1;
  }

  return {
    state: { s, speed: speedAfterWall, lap, lateralOffset, yaw, steer },
    gripExceeded,
    wallContact,
  };
}

// Friction loss applied while sliding along a wall (design 6.3.5): the
// velocity projection alone would let the car slide along the wall at
// constant speed once yaw settles to 0, which is not how scrubbing against
// a barrier behaves. A per-step multiplier close to 1 bleeds speed steadily
// while in contact, without the abruptness of a single deceleration force.
const WALL_FRICTION_FACTOR = 0.995;

/**
 * Resets `state` to the centerline at rest, keeping `s` and `lap`
 * (requirement 4.7.4/4.7.6, design 6.3.6). No automatic reset is ever
 * triggered by this module -- callers invoke it only on an explicit
 * reset-key edge (design 6.5).
 */
export function resetVehicle(state: VehicleState): VehicleState {
  return { s: state.s, speed: 0, lap: state.lap, lateralOffset: 0, yaw: 0, steer: 0 };
}
