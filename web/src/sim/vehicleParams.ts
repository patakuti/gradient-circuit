/**
 * Vehicle tuning constants for sim/vehicle.ts.
 *
 * Design ref: 02_design.md section 6.3 -- these are chosen for driving
 * *feel* (acceleration, top speed, uphill deceleration all reading as
 * plausible for an F1 car), not as a physically accurate model. No lap
 * timing or telemetry data was used to fit them.
 */

import type { VehicleParams } from "./vehicle";

export const DEFAULT_VEHICLE_PARAMS: VehicleParams = {
  mass: 795, // kg, car + driver + fuel, roughly current F1 minimum weight
  maxPower: 735_000, // W, ~1000 PS -- governs the high-speed (power-limited) regime
  maxTractionForce: 15_000, // N -- governs the low-speed (traction-limited) regime
  maxBrakeForce: 30_000, // N, ~3.8g -- stronger than maxTractionForce, as real brakes are
  maxLateralAccel: 40, // m/s^2, ~4.1g -- must exceed maxTractionForce/mass and
  // maxBrakeForce/mass so the cornering speed limit always wins over full throttle
  // (design 6.3 invariant)
  dragFactor: 0.9, // N/(m/s)^2, roughly 0.5 * rho * Cd * A for an F1 car
  rollingResistance: 150, // N
  gravity: 9.81, // m/s^2
};
