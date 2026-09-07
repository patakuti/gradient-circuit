/**
 * Throttle slider + camera-select control.
 *
 * Design ref: 02_design.md section 6.8. DOM-only -- takes and returns plain
 * data (camera ids/labels, a callback), never a `camera/` or `sim/` type,
 * so this module has no dependency on those layers.
 */

export interface CameraOption {
  id: string;
  label: string;
}

export interface Controls {
  slider: HTMLInputElement;
  setActiveCamera(id: string): void;
}

export function createControls(
  parent: HTMLElement,
  cameraOptions: CameraOption[],
  onCameraSelect: (id: string) => void,
): Controls {
  const root = document.createElement("div");
  root.style.cssText =
    "position:fixed;left:12px;bottom:12px;padding:10px 14px;background:rgba(0,0,0,0.55);" +
    "color:#fff;font:13px monospace;border-radius:6px;display:flex;flex-direction:column;gap:8px;z-index:10;";

  const sliderRow = document.createElement("label");
  sliderRow.style.cssText = "display:flex;align-items:center;gap:8px;";
  sliderRow.textContent = "throttle";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  slider.value = "0";
  sliderRow.appendChild(slider);
  root.appendChild(sliderRow);

  const cameraRow = document.createElement("label");
  cameraRow.style.cssText = "display:flex;align-items:center;gap:8px;";
  cameraRow.textContent = "camera";
  const select = document.createElement("select");
  for (const option of cameraOptions) {
    const el = document.createElement("option");
    el.value = option.id;
    el.textContent = option.label;
    select.appendChild(el);
  }
  select.addEventListener("change", () => onCameraSelect(select.value));
  cameraRow.appendChild(select);
  root.appendChild(cameraRow);

  parent.appendChild(root);

  return {
    slider,
    setActiveCamera(id: string) {
      if (select.value !== id) select.value = id;
    },
  };
}
