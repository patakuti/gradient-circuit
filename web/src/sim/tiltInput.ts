/**
 * Device-tilt input (design 6.15.2, requirement 4.8): steering from the
 * device's roll, throttle/brake from its pitch. Implements sim/input.ts's
 * `AxisSource`/`BipolarAxisSource` so main.ts can swap keyboard input for
 * these on a touch-primary device without the physics loop or sim/vehicle.ts
 * changing at all (the same extension point design 6.5 called out for a
 * future gamepad/touch axis).
 *
 * DOM-only (DeviceOrientationEvent, ScreenOrientation, localStorage) -- no
 * `three` import, like sim/input.ts.
 */

import type { AxisSource, BipolarAxisSource } from "./input";

// EMA smoothing factor for the raw sensor signal, matching the reference
// app's (~/CCROOT/vfpv/scripts/android_input.gd) accelerometer filter --
// see 02_design.md section 6.15.
const FILTER_ALPHA = 0.15;

// Degrees from the calibrated neutral that reach full steer lock / full
// throttle-or-brake. Feel parameters, not platform facts -- tune after
// on-device testing.
const MAX_ROLL_DEG = 25;
const MAX_PITCH_DEG = 20;

// `DeviceOrientationEvent.beta`/`gamma` are always relative to the device's
// fixed chassis axes (W3C spec: "this does not affect the orientation of
// the coordinate frame relative to the device"), NOT the current screen
// orientation. This app locks the screen to landscape (design 6.15.6), so
// whenever the phone is actually held the way the OS expects, the chassis
// is physically rotated ~90 degrees from its native portrait pose --  and
// a 90-degree rotation about the chassis's own out-of-screen axis swaps
// which raw value (beta or gamma) lines up with the *visual* roll
// (left/right, as the user currently holds it) versus the visual pitch
// (nose away/toward). That's a structural fact of the rotation, not a
// sign guess: beta feeds roll and gamma feeds pitch here, not the other
// way around, whenever the device is in landscape (see design 6.15.2 for
// the reasoning). landscape-primary and landscape-secondary are 180
// degrees apart around that same axis, which negates both terms uniformly
// without re-swapping them -- so `screenRelativeTilt` below has one branch
// that's just negated for the other, not two independent formulas.
function screenRelativeTilt(rawBeta: number, rawGamma: number): { roll: number; pitch: number } {
  const type = screen.orientation?.type ?? "landscape-primary";
  const flip = type === "landscape-secondary" ? -1 : 1;
  return { roll: flip * rawBeta, pitch: flip * rawGamma };
}

// The *absolute* sign (does positive roll mean steer left or right; does
// positive pitch mean throttle or brake) still can't be assumed (CLAUDE.md:
// "プラットフォーム固有の動作を仮定に基づいて実装NG") -- unlike the
// landscape swap above, this doesn't follow from geometry alone. Confidence
// MEDIUM, not confirmed on real hardware (an emulator attempt was
// inconclusive, see 02_design.md 6.15.5). If steering or throttle/brake
// feels backwards -- but *consistent* regardless of which way the device
// is rotated -- flip the corresponding constant here; if it's
// *inconsistent* depending on device rotation, that's the landscape-swap
// bug above, not this.
//
// Confirmed on a real device (P14 follow-up): ROLL_SIGN=-1 gives the
// expected steering direction. PITCH_SIGN was flipped from -1 to +1 after
// the same on-device test found throttle/brake backwards.
const ROLL_SIGN = -1;
const PITCH_SIGN = 1;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

const CALIBRATION_STORAGE_KEY = "gradient-circuit:tiltCalibration";

interface Calibration {
  roll: number;
  pitch: number;
}

function loadCalibration(): Calibration | null {
  try {
    const raw = localStorage.getItem(CALIBRATION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Calibration>;
    if (typeof parsed.roll !== "number" || typeof parsed.pitch !== "number") return null;
    return { roll: parsed.roll, pitch: parsed.pitch };
  } catch {
    return null;
  }
}

function saveCalibration(calibration: Calibration): void {
  try {
    localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(calibration));
  } catch {
    // localStorage unavailable (private browsing etc.) -- calibration just won't persist across reloads
  }
}

/**
 * Filtered, screen-orientation-compensated device tilt with a calibratable
 * neutral reference (design 6.15.2/6.15.3). One instance is shared by the
 * steer/throttle/brake axes below so they read a consistent,
 * already-filtered sample each frame.
 */
export class TiltSensor {
  private filteredRoll = 0;
  private filteredPitch = 0;
  private refRoll = 0;
  private refPitch = 0;

  constructor() {
    const saved = loadCalibration();
    if (saved) {
      this.refRoll = saved.roll;
      this.refPitch = saved.pitch;
    }
    window.addEventListener("deviceorientation", this.handleOrientation);
  }

  /** Degrees from the calibrated neutral, positive = steer left (see module doc for sign convention). */
  get rollDeg(): number {
    return (this.filteredRoll - this.refRoll) * ROLL_SIGN;
  }

  /** Degrees from the calibrated neutral, positive = forward tilt (see module doc for sign convention). */
  get pitchDeg(): number {
    return (this.filteredPitch - this.refPitch) * PITCH_SIGN;
  }

  /** Sets the current filtered orientation as the neutral reference (design 6.15.3). */
  calibrate(): void {
    this.refRoll = this.filteredRoll;
    this.refPitch = this.filteredPitch;
    saveCalibration({ roll: this.refRoll, pitch: this.refPitch });
  }

  private handleOrientation = (event: DeviceOrientationEvent): void => {
    if (event.gamma === null || event.beta === null) return;
    const { roll, pitch } = screenRelativeTilt(event.beta, event.gamma);
    this.filteredRoll += (roll - this.filteredRoll) * FILTER_ALPHA;
    this.filteredPitch += (pitch - this.filteredPitch) * FILTER_ALPHA;
  };
}

/** Steering from device roll (design 6.15.2). Always active on a touch-primary device -- ignored by "auto" mode same as keyboard steer (design 6.14.5). */
export class TiltSteerAxis implements BipolarAxisSource {
  constructor(private readonly sensor: TiltSensor) {}

  read(): number {
    return clamp(this.sensor.rollDeg / MAX_ROLL_DEG, -1, 1);
  }
}

/** Throttle from forward device pitch ("前後傾き" scheme, design 6.15.3). */
export class TiltThrottleAxis implements AxisSource {
  constructor(private readonly sensor: TiltSensor) {}

  read(): number {
    return clamp(this.sensor.pitchDeg / MAX_PITCH_DEG, 0, 1);
  }
}

/** Brake from backward device pitch ("前後傾き" scheme, design 6.15.3). */
export class TiltBrakeAxis implements AxisSource {
  constructor(private readonly sensor: TiltSensor) {}

  read(): number {
    return clamp(-this.sensor.pitchDeg / MAX_PITCH_DEG, 0, 1);
  }
}
