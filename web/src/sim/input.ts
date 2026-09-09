/**
 * Throttle/brake input, keyboard only.
 *
 * Design ref: 02_design.md section 6.5. Requirements 4.2: keyboard is the
 * only input (no slider/pointer control). Throttle and brake are each a
 * separate `KeyboardAxis` reading their own key set as a binary [0,1]
 * value.
 */

export interface AxisSource {
  read(): number; // [0, 1]
}

export const THROTTLE_KEYS = new Set(["ArrowUp", "KeyW"]);
export const BRAKE_KEYS = new Set(["ArrowDown", "KeyS"]);

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
