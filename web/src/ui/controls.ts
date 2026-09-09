/**
 * Camera-select + course-select controls.
 *
 * Design ref: 02_design.md section 6.8. DOM-only -- takes and returns plain
 * data (camera ids/labels, a callback), never a `camera/` or `sim/` type,
 * so this module has no dependency on those layers. Throttle/brake are
 * keyboard-only (design 6.5) and have no UI element here.
 */

export interface CameraOption {
  id: string;
  label: string;
}

export interface CourseOption {
  id: string;
  label: string;
}

export interface Controls {
  setActiveCamera(id: string): void;
}

export function createControls(
  parent: HTMLElement,
  cameraOptions: CameraOption[],
  onCameraSelect: (id: string) => void,
  courseOptions: CourseOption[],
  activeCourseId: string,
  onCourseSelect: (id: string) => void,
): Controls {
  const root = document.createElement("div");
  root.style.cssText =
    "position:fixed;left:12px;bottom:12px;padding:10px 14px;background:rgba(0,0,0,0.55);" +
    "color:#fff;font:13px monospace;border-radius:6px;display:flex;flex-direction:column;gap:8px;z-index:10;";

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

  const courseRow = document.createElement("label");
  courseRow.style.cssText = "display:flex;align-items:center;gap:8px;";
  courseRow.textContent = "course";
  const courseSelect = document.createElement("select");
  for (const option of courseOptions) {
    const el = document.createElement("option");
    el.value = option.id;
    el.textContent = option.label;
    if (option.id === activeCourseId) el.selected = true;
    courseSelect.appendChild(el);
  }
  // Course switching re-initializes the whole scene (design 6.9), so unlike
  // the camera select this doesn't go through a live callback -- it's
  // treated as a navigation.
  courseSelect.addEventListener("change", () => onCourseSelect(courseSelect.value));
  courseRow.appendChild(courseSelect);
  root.appendChild(courseRow);

  parent.appendChild(root);

  return {
    setActiveCamera(id: string) {
      if (select.value !== id) select.value = id;
    },
  };
}
