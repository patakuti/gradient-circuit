/**
 * Throttle input sources.
 *
 * Design ref: 02_design.md section 6.5. Primary input is an on-screen
 * slider; keyboard (Up / W) is a secondary input on the same single axis,
 * not a separate control scheme -- it also drives the slider's displayed
 * value so the two stay visually consistent. `CombinedThrottle` merges any
 * number of sources by taking the max.
 */

export interface ThrottleSource {
  read(): number; // [0, 1]
}

/** Reads an `<input type="range">` element (0-100) as a [0,1] throttle value. */
export class SliderThrottle implements ThrottleSource {
  constructor(private readonly slider: HTMLInputElement) {}

  read(): number {
    return Number(this.slider.value) / 100;
  }

  /** Programmatically move the slider, e.g. to mirror keyboard input. */
  setValue(value01: number): void {
    this.slider.value = String(Math.round(Math.max(0, Math.min(1, value01)) * 100));
  }
}

const THROTTLE_KEYS = new Set(["ArrowUp", "KeyW"]);

/** Reads Up/W as a binary [0,1] throttle; optionally mirrors a slider. */
export class KeyboardThrottle implements ThrottleSource {
  private active = false;

  constructor(private readonly slider?: SliderThrottle) {
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
  }

  read(): number {
    return this.active ? 1 : 0;
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!THROTTLE_KEYS.has(event.code)) return;
    this.active = true;
    this.slider?.setValue(this.read());
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    if (!THROTTLE_KEYS.has(event.code)) return;
    this.active = false;
    this.slider?.setValue(this.read());
  };
}

/** Combines multiple throttle sources by taking their maximum. */
export class CombinedThrottle implements ThrottleSource {
  constructor(private readonly sources: ThrottleSource[]) {}

  read(): number {
    return this.sources.reduce((max, source) => Math.max(max, source.read()), 0);
  }
}
