/**
 * Touch-pedal input (design 6.15.2/6.15.3, requirement 4.8): a screen
 * rectangle read as a binary [0, 1] axis while any touch point is inside
 * it, the same semantics as sim/input.ts's `KeyboardAxis`. DOM-only (Touch
 * Events) -- no `three` import, like sim/input.ts.
 */

import type { AxisSource } from "./input";

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function containsPoint(rect: ScreenRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * Tracks touches by identifier so a finger dragged out of `getRect()`'s
 * current rectangle still releases the axis (touchmove/touchend carry the
 * same identifier the matching touchstart had -- standard Touch Events
 * behavior), and multiple simultaneous touches elsewhere on screen (e.g.
 * the other pedal) don't interfere.
 */
export class TouchZoneAxis implements AxisSource {
  private activeTouchIds = new Set<number>();

  /**
   * `getRect` is a function, not a fixed rectangle, because the zone's
   * on-screen position depends on the viewport size, which can change
   * (orientation change, resize) after construction.
   */
  constructor(private readonly getRect: () => ScreenRect) {
    window.addEventListener("touchstart", this.handleTouchStart, { passive: true });
    window.addEventListener("touchmove", this.handleTouchMove, { passive: true });
    window.addEventListener("touchend", this.handleTouchEnd, { passive: true });
    window.addEventListener("touchcancel", this.handleTouchEnd, { passive: true });
  }

  read(): number {
    return this.activeTouchIds.size > 0 ? 1 : 0;
  }

  private handleTouchStart = (event: TouchEvent): void => {
    const rect = this.getRect();
    for (const touch of Array.from(event.changedTouches)) {
      if (containsPoint(rect, touch.clientX, touch.clientY)) this.activeTouchIds.add(touch.identifier);
    }
  };

  private handleTouchMove = (event: TouchEvent): void => {
    const rect = this.getRect();
    for (const touch of Array.from(event.changedTouches)) {
      if (containsPoint(rect, touch.clientX, touch.clientY)) {
        this.activeTouchIds.add(touch.identifier);
      } else {
        this.activeTouchIds.delete(touch.identifier);
      }
    }
  };

  private handleTouchEnd = (event: TouchEvent): void => {
    for (const touch of Array.from(event.changedTouches)) this.activeTouchIds.delete(touch.identifier);
  };
}
