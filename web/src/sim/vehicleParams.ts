/**
 * Vehicle tuning constants for sim/vehicle.ts.
 *
 * Design ref: 02_design.md section 6.3.7. Most of these are chosen for
 * driving *feel* (acceleration, top speed, uphill deceleration all reading
 * as plausible for an F1 car), not as a physically accurate model -- no
 * lap timing or telemetry data was used to fit them. The lateral-grip
 * constants are the deliberate exception: they come from `tools
 * gradient-circuit fit-grip` (design 4.9), a least-squares fit against
 * real FastF1 telemetry (1025 clean laps, Monaco + Suzuka pooled), not a
 * feel-tuned guess.
 */

import type { VehicleParams } from "./vehicle";

export const DEFAULT_VEHICLE_PARAMS: VehicleParams = {
  mass: 795, // kg, car + driver + fuel, roughly current F1 minimum weight
  maxPower: 735_000, // W, ~1000 PS -- governs the high-speed (power-limited) regime
  maxTractionForce: 15_000, // N -- governs the low-speed (traction-limited) regime
  maxBrakeForce: 30_000, // N, ~3.8g -- stronger than maxTractionForce, as real brakes are
  dragFactor: 0.9, // N/(m/s)^2, roughly 0.5 * rho * Cd * A for an F1 car
  rollingResistance: 150, // N
  gravity: 9.81, // m/s^2

  // Speed-dependent lateral grip (design 4.9): lateralGripAt(v) =
  // min(mechLateralAccel + aeroLateralCoeff * v^2, maxLateralAccelCap).
  // Measured, not tuned -- see 02_design.md 4.9 for the fit methodology
  // and its validation (tightest-corner real-vs-model speed ratio 0.97-0.98).
  mechLateralAccel: 19.46, // m/s^2 (~1.98g), a0: mechanical grip at v=0
  aeroLateralCoeff: 0.00736, // 1/m, k: downforce term
  maxLateralAccelCap: 60.88, // m/s^2 (~6.21g), tire load-sensitivity ceiling

  // Steering (design 6.3.7). Unlike the grip constants above, these are
  // feel-tuned placeholders pending the P12.3 in-browser drive test --
  // "how fast should the wheel turn" and "how much of the available grip
  // does full lock demand" are not answerable from telemetry alone.
  wheelBase: 3.6, // m, current F1 cars' published wheelbase range is ~3.4-3.6m (secondary source, medium confidence)
  maxSteerAngle: 0.35, // rad (~20deg), real F1 steer angle is roughly this range (secondary source, low-medium confidence)
  steerRate: 3.0, // 1/s -- ~0.33s neutral-to-full-lock; must be nonzero per requirement 4.2.2 ("not instant")
  steerReturnRate: 4.0, // 1/s -- self-centering is faster than steering in, per requirement 4.2.2
  steerGripFactor: 1.5, // must exceed 1 so full lock alone can exceed the grip limit (design 6.3.4 invariant)
  maxYaw: 1.05, // rad (60deg) -- caps |yaw|, structurally rules out spin/reverse (requirement 2.2); must stay < pi/2 (sim/vehicle.ts relies on cos(yaw) > 0)

  // Wall contact (design 6.3.5, P13.2 follow-up): sim/ treats the vehicle
  // as a point for surface/collision purposes (design 6.13.1), but a wall
  // stopping the *center* point lets the visible body clip through it by
  // half its width. This offsets the stop by the body's actual widest
  // point instead. Kept in sync by hand with render/vehicleMesh.ts's
  // REAR_WIDTH/2 + WHEEL_THICKNESS/2 (0.8 + 0.14 = 0.94, rounded up) --
  // sim/ must not import render/ (design 6.1), so this can't be a shared
  // constant (same tradeoff as audio/engine.ts's CURB_BUMP_PERIOD_M).
  vehicleHalfWidth: 0.95, // m
};
