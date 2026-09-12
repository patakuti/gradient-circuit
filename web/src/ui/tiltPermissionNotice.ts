/**
 * One-shot banner shown when iOS Safari's tilt-sensor permission request
 * (sim/tiltInput.ts's `requestPermissionIfNeeded()`, design 6.15.7) comes
 * back denied, so the driver isn't left with silently-dead steering and no
 * explanation. Kept as its own small module rather than folded into
 * ui/hud.ts or ui/controls.ts since this only ever applies to a rare,
 * iOS-only, one-time state that the rest of those modules don't need to
 * know about.
 */

const MESSAGE =
  "Tilt steering needs motion access. Enable it in Settings > Safari > Motion & Orientation Access, then reload.";

export function showTiltPermissionDeniedNotice(parent: HTMLElement): void {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;top:12px;left:50%;transform:translateX(-50%);max-width:min(90vw,420px);" +
    "padding:10px 36px 10px 14px;background:rgba(120,20,20,0.85);color:#fff;font:13px monospace;" +
    "line-height:1.4;border-radius:6px;z-index:20;";
  el.textContent = MESSAGE;

  const closeButton = document.createElement("button");
  closeButton.textContent = "×";
  closeButton.setAttribute("aria-label", "Dismiss");
  closeButton.style.cssText =
    "position:absolute;top:4px;right:6px;width:24px;height:24px;border:none;border-radius:4px;" +
    "background:transparent;color:#fff;font-size:16px;line-height:1;cursor:pointer;";
  closeButton.addEventListener("click", () => el.remove());
  el.appendChild(closeButton);

  parent.appendChild(el);
}
