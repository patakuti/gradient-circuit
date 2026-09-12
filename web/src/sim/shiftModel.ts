/**
 * Gear/RPM as a pure function of speed (requirement 4.9, design 6.16).
 *
 * Display/sound only -- this has no effect on sim/vehicle.ts's physics
 * (design 4.9's own opening line: the vehicle model has no gearbox, only
 * "distance s and lateral offset d"). `main.ts` calls updateGear() once
 * per frame (not once per fixed physics step, design 6.4) and feeds its
 * result into audio/engine.ts and ui/gauges.ts -- never back into
 * VehicleInput or stepVehicle.
 */

export interface GearRpmCoeff {
  slope: number; // RPM per m/s
  intercept: number; // RPM at 0 m/s (extrapolated, design 4.10 -- not necessarily physical at v=0)
}

/** Measured from real telemetry (`tools fit-shift`, design 4.10) -- see
 * vehicleParams.ts's DEFAULT_SHIFT_PARAMS for the values and provenance. */
export interface ShiftParams {
  gearCount: number;
  idleRpm: number;
  redlineRpm: number;
  /** shiftUpSpeeds[g-1] [m/s]: speed above which gear g shifts up to g+1. Length gearCount-1. */
  shiftUpSpeeds: number[];
  /** shiftDownSpeeds[g-1] [m/s]: speed below which gear g+1 shifts down to g. Length gearCount-1. */
  shiftDownSpeeds: number[];
  /** gearRpmCoeffs[g-1]: RPM ~ speed fit for gear g. Length gearCount. */
  gearRpmCoeffs: GearRpmCoeff[];
}

export interface ShiftState {
  gear: number; // 1-indexed
  rpm: number;
}

export const INITIAL_GEAR = 1;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * One frame's gear/RPM update. `prevGear` carries the hysteresis (design
 * 6.16): shiftUpSpeeds/shiftDownSpeeds are separate measured thresholds,
 * so a gear doesn't hunt back and forth at a single boundary speed.
 *
 * Moves by at most one gear per call by design -- called every frame
 * during normal driving, acceleration/deceleration is continuous, so a
 * multi-gear jump within one frame doesn't happen. The one case that
 * could produce one (a `R` reset snapping speed to 0) is handled by
 * main.ts explicitly resetting `prevGear` to INITIAL_GEAR alongside the
 * vehicle state, rather than relying on this function to cascade down
 * across several frames.
 */
export function updateGear(prevGear: number, speedMps: number, params: ShiftParams): ShiftState {
  let gear = prevGear;
  if (gear < params.gearCount && speedMps > params.shiftUpSpeeds[gear - 1]) {
    gear += 1;
  } else if (gear > 1 && speedMps < params.shiftDownSpeeds[gear - 2]) {
    gear -= 1;
  }
  const { slope, intercept } = params.gearRpmCoeffs[gear - 1];
  const rpm = clamp(intercept + slope * speedMps, params.idleRpm, params.redlineRpm);
  return { gear, rpm };
}
