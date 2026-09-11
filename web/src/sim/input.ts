/**
 * Throttle/brake/steer/mode/reset input, keyboard only.
 *
 * Design ref: 02_design.md section 6.5. Requirements 4.2.2: keyboard is
 * the only input (no slider/pointer control). Throttle and brake are each
 * a binary [0,1] axis; steering is a bipolar three-value axis (the analog
 * ramping itself happens in sim/vehicle.ts, not here -- see 6.5's design
 * rationale for keeping this module a plain, dt-independent key reader).
 */

export interface AxisSource {
  read(): number; // [0, 1]
}

export interface BipolarAxisSource {
  read(): number; // [-1, 0, 1]
}

export const THROTTLE_KEYS = new Set(["ArrowUp", "KeyW"]);
export const BRAKE_KEYS = new Set(["ArrowDown", "KeyS"]);
export const STEER_LEFT_KEYS = new Set(["ArrowLeft", "KeyA"]);
export const STEER_RIGHT_KEYS = new Set(["ArrowRight", "KeyD"]);
export const MODE_KEYS = new Set(["KeyM"]);
export const RESET_KEYS = new Set(["KeyR"]);

/** Reads a key set as a binary [0,1] axis: 1 while any of its keys is held. */
export class KeyboardAxis implements AxisSource {
  private active = false;

  constructor(private readonly keys: ReadonlySet<string>) {
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
  }

  read(): number {
    return this.active ? 1 : 0;
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.keys.has(event.code)) return;
    this.active = true;
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    if (!this.keys.has(event.code)) return;
    this.active = false;
  };
}

/**
 * Reads a pair of key sets as a three-value axis: +1 while only the
 * "positive" (left) set is held, -1 while only the "negative" (right) set
 * is held, 0 otherwise -- including both held at once (requirement 4.2.2:
 * simultaneous left+right cancels out, returning to neutral).
 */
export class KeyboardBipolarAxis implements BipolarAxisSource {
  private positiveActive = false;
  private negativeActive = false;

  constructor(
    private readonly positiveKeys: ReadonlySet<string>,
    private readonly negativeKeys: ReadonlySet<string>,
  ) {
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
  }

  read(): number {
    return (this.positiveActive ? 1 : 0) - (this.negativeActive ? 1 : 0);
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (this.positiveKeys.has(event.code)) this.positiveActive = true;
    if (this.negativeKeys.has(event.code)) this.negativeActive = true;
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    if (this.positiveKeys.has(event.code)) this.positiveActive = false;
    if (this.negativeKeys.has(event.code)) this.negativeActive = false;
  };
}

/**
 * Edge-detects a key set: `consume()` reports whether any of its keys was
 * pressed since the last call and clears the flag, so a held key doesn't
 * re-fire every frame (design 6.5 -- used for mode-switch and reset, which
 * are one-shot actions, unlike throttle/brake/steer's continuous axes).
 */
export class KeyTrigger {
  private pending = false;

  constructor(private readonly keys: ReadonlySet<string>) {
    window.addEventListener("keydown", this.handleKeyDown);
  }

  consume(): boolean {
    const fired = this.pending;
    this.pending = false;
    return fired;
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.keys.has(event.code)) return;
    if (event.repeat) return; // OS key-repeat must not fire multiple edges
    this.pending = true;
  };
}
