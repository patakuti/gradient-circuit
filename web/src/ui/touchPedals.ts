/**
 * Visible touch-pedal zones for the "タッチペダル" throttle/brake scheme
 * (design 6.15.2/6.15.3, requirement 4.8). Draws two semi-transparent
 * regions (brake bottom-left, throttle bottom-right) and hands their
 * screen rectangles to sim/touchInput.ts's `TouchZoneAxis` -- this module
 * owns the visual affordance, TouchZoneAxis owns the touch-tracking logic
 * (design 6.1's ui/sim split).
 */

import { TouchZoneAxis, type ScreenRect } from "../sim/touchInput";
import type { AxisSource } from "../sim/input";

const PEDAL_WIDTH_VW = 32; // vw, leaves a dead zone in the middle so a wide thumb can't hit both
const PEDAL_HEIGHT_VH = 28; // vh

function createPedalElement(parent: HTMLElement, side: "left" | "right", label: string): HTMLElement {
  const el = document.createElement("div");
  el.textContent = label;
  el.style.cssText =
    `position:fixed;${side}:0;bottom:0;width:${PEDAL_WIDTH_VW}vw;height:${PEDAL_HEIGHT_VH}vh;` +
    "display:flex;align-items:flex-end;justify-content:center;padding-bottom:16px;box-sizing:border-box;" +
    "background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.6);font:13px monospace;" +
    "user-select:none;touch-action:none;z-index:10;";
  parent.appendChild(el);
  return el;
}

function rectOf(el: HTMLElement): ScreenRect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

export interface TouchPedals {
  throttle: AxisSource;
  brake: AxisSource;
  /** Shows/hides both pedal zones (P14 follow-up) -- used when the driver
   * switches to the "前後傾き" scheme live, so the now-inert pedals don't
   * sit on screen looking like they still do something. */
  setVisible(visible: boolean): void;
}

export function createTouchPedals(parent: HTMLElement): TouchPedals {
  const brakeEl = createPedalElement(parent, "left", "brake");
  const throttleEl = createPedalElement(parent, "right", "throttle");

  return {
    throttle: new TouchZoneAxis(() => rectOf(throttleEl)),
    brake: new TouchZoneAxis(() => rectOf(brakeEl)),
    setVisible(visible: boolean) {
      brakeEl.style.display = visible ? "flex" : "none";
      throttleEl.style.display = visible ? "flex" : "none";
    },
  };
}
