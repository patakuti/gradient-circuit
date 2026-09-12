/**
 * Analog speedometer/tachometer gauge cluster (requirement 4.9.2, design
 * 6.16). A `<canvas>` element separate from the text HUD (ui/hud.ts) --
 * drawing dials and formatting text are different enough concerns that
 * keeping them in one class would blur both (design 6.9's own note).
 *
 * No external images: needle/dial faces are drawn with
 * CanvasRenderingContext2D primitives only, matching the "no external
 * assets" policy render/vehicleMesh.ts and audio/engine.ts already follow.
 */

const CANVAS_SIZE_NORMAL = 200;
const CANVAS_SIZE_MINIMAL = 130; // requirement 4.9.2: touch-primary HUD stays compact

// A dial sweeps this many degrees, centered on straight up (-90deg in
// canvas angle convention), leaving a gap at the bottom for the numeric
// readout -- the common automotive-gauge layout.
const SWEEP_DEG = 240;
const SWEEP_START_DEG = 90 + (360 - SWEEP_DEG) / 2; // canvas angle, 0 = +x axis, clockwise

const SPEEDO_MAX_KMH = 360; // headroom above any speed this car's vehicleParams.ts allows

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Angle (canvas convention, radians) for a value fraction in [0, 1] along the sweep. */
function angleFor(frac: number): number {
  return toRad(SWEEP_START_DEG + SWEEP_DEG * clamp01(frac));
}

function drawDial(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  valueFrac: number,
  label: string,
  valueText: string,
  redlineFrac: number | null,
): void {
  const startAngle = angleFor(0);
  const endAngle = angleFor(1);

  // Face
  ctx.beginPath();
  ctx.arc(cx, cy, radius, startAngle, endAngle);
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = radius * 0.12;
  ctx.stroke();

  // Redline band (tachometer only)
  if (redlineFrac !== null && redlineFrac < 1) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, angleFor(redlineFrac), endAngle);
    ctx.strokeStyle = "rgba(220,60,50,0.85)";
    ctx.lineWidth = radius * 0.12;
    ctx.stroke();
  }

  // Needle
  const needleAngle = angleFor(valueFrac);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(needleAngle) * radius * 0.82, cy + Math.sin(needleAngle) * radius * 0.82);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = Math.max(2, radius * 0.06);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.08, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();

  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = `${Math.round(radius * 0.22)}px monospace`;
  ctx.fillText(valueText, cx, cy + radius * 0.55);
  ctx.font = `${Math.round(radius * 0.14)}px monospace`;
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.fillText(label, cx, cy - radius * 0.35);
}

export class Gauges {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly size: number;

  constructor(parent: HTMLElement, minimal: boolean) {
    this.size = minimal ? CANVAS_SIZE_MINIMAL : CANVAS_SIZE_NORMAL;
    const canvas = document.createElement("canvas");
    // devicePixelRatio-scaled backing store, CSS size fixed to `size` --
    // same pattern as render/'s canvas-based procedural textures use for
    // crisp lines on high-DPI screens.
    const dpr = window.devicePixelRatio || 1;
    canvas.width = this.size * 2 * dpr;
    canvas.height = this.size * dpr;
    canvas.style.cssText =
      `position:fixed;right:8px;bottom:8px;width:${this.size * 2}px;height:${this.size}px;` +
      "z-index:10;pointer-events:none;";
    parent.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Gauges: 2D canvas context unavailable");
    ctx.scale(dpr, dpr);
    this.ctx = ctx;
  }

  /** Caller skips this while paused (design 6.15.6/P14), same as
   * `engineAudio.update()` -- freezes the last frame rather than ticking
   * with whatever the driver's held input happens to read while paused. */
  update(speedKmh: number, rpm: number, gear: number, idleRpm: number, redlineRpm: number): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.size * 2, this.size);

    const r = this.size * 0.46;
    const cy = this.size * 0.56;
    const rpmRange = Math.max(1, redlineRpm - idleRpm);
    const rpmFrac = clamp01((rpm - idleRpm) / rpmRange);
    drawDial(ctx, this.size * 0.5, cy, r, rpmFrac, `GEAR ${gear}`, rpm.toFixed(0), 0.85);
    drawDial(ctx, this.size * 1.5, cy, r, speedKmh / SPEEDO_MAX_KMH, "km/h", speedKmh.toFixed(0), null);
  }
}
