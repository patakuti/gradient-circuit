/**
 * HUD overlay: speed / throttle / brake / steer / elevation / grade / lap /
 * lap time / drive mode / active camera, plus an optional debug panel.
 *
 * Design ref: 02_design.md section 6.9. DOM-only, no `three` or `sim/`
 * imports -- main.ts computes every displayed value and passes plain data
 * in via update().
 */

export interface HudData {
  speedKmh: number;
  throttlePercent: number;
  brakePercent: number;
  steerPercent: number; // [-100, 100], positive = left (design 6.9, P12)
  elevationM: number;
  gradePercent: number;
  lap: number;
  lapDistanceM: number;
  lastLapTimeS: number | null;
  driveModeLabel: string; // "auto" | "manual" (design 6.14.5, P12)
  cameraLabel: string;
}

export interface DebugData {
  s: number;
  curvature: number;
  widthLeft: number;
  widthRight: number;
  lateralOffset: number; // [m] (design 6.9, P12)
  yawDeg: number; // [deg] (design 6.9, P12)
  gripExceeded: boolean; // design 6.9, P12
  fps: number;
}

function formatLapTime(seconds: number | null): string {
  if (seconds === null) return "--:--.---";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(3).padStart(6, "0")}`;
}

export class Hud {
  private readonly mainLines: HTMLElement;
  private readonly debugLines: HTMLElement | null;

  constructor(parent: HTMLElement, showDebug: boolean, courseName: string) {
    const root = document.createElement("div");
    root.style.cssText =
      "position:fixed;top:12px;left:12px;padding:10px 14px;background:rgba(0,0,0,0.55);" +
      "color:#fff;font:13px monospace;border-radius:6px;line-height:1.6;z-index:10;white-space:pre;";

    const courseLine = document.createElement("div");
    courseLine.style.cssText = "font-weight:bold;margin-bottom:6px;";
    courseLine.textContent = courseName;
    root.appendChild(courseLine);

    this.mainLines = document.createElement("div");
    root.appendChild(this.mainLines);

    if (showDebug) {
      this.debugLines = document.createElement("div");
      this.debugLines.style.cssText =
        "margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.3);opacity:0.85;";
      root.appendChild(this.debugLines);
    } else {
      this.debugLines = null;
    }

    parent.appendChild(root);
  }

  update(data: HudData, debug?: DebugData): void {
    this.mainLines.textContent =
      `speed: ${data.speedKmh.toFixed(0)} km/h\n` +
      `throttle: ${data.throttlePercent.toFixed(0)}%  brake: ${data.brakePercent.toFixed(0)}%  ` +
      `steer: ${data.steerPercent >= 0 ? "L" : "R"}${Math.abs(data.steerPercent).toFixed(0)}%\n` +
      `elevation: ${data.elevationM.toFixed(1)} m\n` +
      `grade: ${data.gradePercent.toFixed(1)}%\n` +
      `lap: ${data.lap}  dist: ${data.lapDistanceM.toFixed(0)} m\n` +
      `last lap: ${formatLapTime(data.lastLapTimeS)}\n` +
      `mode: ${data.driveModeLabel}  [M] switch\n` +
      `camera: ${data.cameraLabel}  [C] switch`;

    if (this.debugLines && debug) {
      this.debugLines.textContent =
        `s: ${debug.s.toFixed(1)}  curvature: ${debug.curvature.toFixed(4)} 1/m\n` +
        `width L/R: ${debug.widthLeft.toFixed(1)} / ${debug.widthRight.toFixed(1)} m\n` +
        `d: ${debug.lateralOffset.toFixed(2)} m  yaw: ${debug.yawDeg.toFixed(1)} deg  ` +
        `grip: ${debug.gripExceeded ? "EXCEEDED" : "ok"}\n` +
        `fps: ${debug.fps.toFixed(0)}`;
    }
  }
}
