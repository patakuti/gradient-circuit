/**
 * Camera-select + drive-mode-select + course-select + mute controls.
 *
 * Design ref: 02_design.md section 6.8/6.10/6.14.5. DOM-only -- takes and
 * returns plain data (ids/labels, callbacks), never a `camera/`, `sim/` or
 * `audio/` type, so this module has no dependency on those layers.
 * Throttle/brake/steer are keyboard-only (design 6.5) and have no UI
 * element here.
 */

export interface CameraOption {
  id: string;
  label: string;
}

export interface DriveModeOption {
  id: string;
  label: string;
}

export interface CourseOption {
  id: string;
  label: string;
}

export interface Controls {
  setActiveCamera(id: string): void;
  setActiveMode(id: string): void;
}

export function createControls(
  parent: HTMLElement,
  cameraOptions: CameraOption[],
  onCameraSelect: (id: string) => void,
  driveModeOptions: DriveModeOption[],
  onDriveModeSelect: (id: string) => void,
  courseOptions: CourseOption[],
  activeCourseId: string,
  onCourseSelect: (id: string) => void,
  onMuteToggle: (muted: boolean) => void,
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

  // Drive mode: a live toggle like the camera select (not a navigation
  // like course select), per design 6.14.5.
  const modeRow = document.createElement("label");
  modeRow.style.cssText = "display:flex;align-items:center;gap:8px;";
  modeRow.textContent = "mode";
  const modeSelect = document.createElement("select");
  for (const option of driveModeOptions) {
    const el = document.createElement("option");
    el.value = option.id;
    el.textContent = option.label;
    modeSelect.appendChild(el);
  }
  modeSelect.addEventListener("change", () => onDriveModeSelect(modeSelect.value));
  modeRow.appendChild(modeSelect);
  root.appendChild(modeRow);

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

  let muted = false;
  const muteButton = document.createElement("button");
  muteButton.textContent = "mute";
  muteButton.addEventListener("click", () => {
    muted = !muted;
    muteButton.textContent = muted ? "unmute" : "mute";
    onMuteToggle(muted);
  });
  root.appendChild(muteButton);

  parent.appendChild(root);

  return {
    setActiveCamera(id: string) {
      if (select.value !== id) select.value = id;
    },
    setActiveMode(id: string) {
      if (modeSelect.value !== id) modeSelect.value = id;
    },
  };
}
