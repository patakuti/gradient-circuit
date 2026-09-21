/**
 * Device vibration for driving events (curb, grass, wall, brake, grip-limit
 * overshoot), via the Web Vibration API.
 *
 * Design ref: 02_design.md section 6.15.8. No `three`, `sim/` or `render/`
 * imports -- main.ts derives every value passed into selectVibration(),
 * same layering as audio/engine.ts (design 6.1).
 */

export interface VibrationState {
  speed: number; // [m/s]
  brake: number; // [0, 1]
  // sim/vehicle.ts's grip-limit-exceeded flag: the same condition that
  // starts audio/engine.ts's cornering-scrub sound (design 6.15.8/P24).
  gripExceeded: boolean;
  onCurb: boolean;
  onGrass: boolean;
  wallContact: boolean;
}

export type VibrationKind = "wall" | "curb" | "grass" | "grip" | "brake";

/** One repeating pulse: vibrate for `onMs`, pause for `offMs`. */
export interface VibrationCue {
  kind: VibrationKind;
  onMs: number;
  offMs: number;
}

// Feel-tuned placeholders pending real-device confirmation (design 6.15.8,
// same status as the other tuning constants in this codebase).
const BRAKE_MIN_INPUT = 0.3; // [0, 1]
const BRAKE_MIN_SPEED = 3; // [m/s] same as audio/engine.ts's BRAKE_SOUND_MIN_SPEED
const CURB_ON_MS = 30;
const CURB_MIN_OFF_MS = 30;
const CURB_MAX_OFF_MS = 250; // caps the gap at crawl speed so one pattern never outlasts PATTERN_SPAN_MS by much
const CURB_BUMP_PERIOD_M = 4; // same as audio/engine.ts's curb thump period
const CURB_MIN_SPEED = 0.5; // [m/s] avoids an infinite period at standstill
const GRASS_MIN_SPEED = 1; // [m/s] "while driving": no rumble when stopped on the grass

const WALL_CUE: VibrationCue = { kind: "wall", onMs: 60, offMs: 20 };
const GRASS_CUE: VibrationCue = { kind: "grass", onMs: 15, offMs: 25 };
const GRIP_CUE: VibrationCue = { kind: "grip", onMs: 25, offMs: 60 };
const BRAKE_CUE: VibrationCue = { kind: "brake", onMs: 20, offMs: 60 };

/**
 * Picks the one cue to play. Only one vibrator exists and its amplitude
 * can't be controlled, so when several conditions hold at once the most
 * severe wins: wall > curb > grass > grip limit > brake (design 6.15.8).
 */
export function selectVibration(state: VibrationState): VibrationCue | null {
  if (state.wallContact) return WALL_CUE;
  if (state.onCurb) {
    // Thump rate follows how fast the curb stripes pass, like the curb sound.
    const periodMs = (CURB_BUMP_PERIOD_M / Math.max(CURB_MIN_SPEED, state.speed)) * 1000;
    return { kind: "curb", onMs: CURB_ON_MS, offMs: Math.min(CURB_MAX_OFF_MS, Math.max(CURB_MIN_OFF_MS, periodMs - CURB_ON_MS)) };
  }
  if (state.onGrass && state.speed >= GRASS_MIN_SPEED) return GRASS_CUE;
  if (state.gripExceeded) return GRIP_CUE;
  if (state.brake >= BRAKE_MIN_INPUT && state.speed >= BRAKE_MIN_SPEED) return BRAKE_CUE;
  return null;
}

/** How long one issued pattern runs before it's re-issued (design 6.15.8). */
const PATTERN_SPAN_MS = 300;

/** Repeats `cue`'s pulse until the pattern spans at least PATTERN_SPAN_MS. */
export function buildPattern(cue: VibrationCue): number[] {
  const cycleMs = cue.onMs + cue.offMs;
  const repeats = Math.max(1, Math.ceil(PATTERN_SPAN_MS / cycleMs));
  const pattern: number[] = [];
  for (let i = 0; i < repeats; i++) pattern.push(Math.round(cue.onMs), Math.round(cue.offMs));
  return pattern;
}

/**
 * Issues cues to `navigator.vibrate`. A new `vibrate()` call replaces the
 * pattern in flight, so calling it every frame would cut the rhythm short;
 * instead a pattern is only (re)issued when the cue kind changes or the
 * previous one has run out (design 6.15.8).
 */
export class Vibrator {
  private enabled = true;
  private activeKind: VibrationKind | null = null;
  private patternEndMs = 0;

  /** True when this environment has a vibrator to drive (design 6.15.8). */
  static isSupported(): boolean {
    return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
  }

  /** Kind of the cue currently being played, for the DEBUG HUD. */
  get current(): VibrationKind | null {
    return this.activeKind;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.stop();
  }

  update(cue: VibrationCue | null, nowMs: number): void {
    if (!this.enabled || !Vibrator.isSupported() || cue === null) {
      this.stop();
      return;
    }
    if (cue.kind === this.activeKind && nowMs < this.patternEndMs) return;
    const pattern = buildPattern(cue);
    navigator.vibrate(pattern);
    this.activeKind = cue.kind;
    this.patternEndMs = nowMs + pattern.reduce((sum, ms) => sum + ms, 0);
  }

  /** Cancels any pattern in flight; a no-op if nothing is playing. */
  stop(): void {
    if (this.activeKind === null) return;
    this.activeKind = null;
    this.patternEndMs = 0;
    if (Vibrator.isSupported()) navigator.vibrate(0);
  }
}
