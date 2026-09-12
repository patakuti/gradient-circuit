/**
 * Camera-select + drive-mode-select + course-select + mute controls.
 *
 * Design ref: 02_design.md section 6.8/6.10/6.14.5. DOM-only -- takes and
 * returns plain data (ids/labels, callbacks), never a `camera/`, `sim/` or
 * `audio/` type, so this module has no dependency on those layers.
 * Throttle/brake/steer are keyboard-only on desktop (design 6.5) and have
 * no UI element here. On a touch-primary device (design 6.15.3), passing
 * `androidControls` adds a row for the throttle/brake input scheme, a
 * calibration button and a reset button -- the caller decides touch-primary
 * via `matchMedia`, so this module doesn't need to know how. There the whole
 * panel also starts hidden and is opened/closed from a small "☰" menu
 * button, vfpv-style, instead of staying on screen (P14 follow-up), and
 * opening it pauses the drive via `onMenuToggle` (main.ts owns what
 * "paused" means, same ui/sim split as everywhere else in this module); on
 * desktop it stays visible like before, with no menu button and no pause.
 */

export interface CameraOption {
  id: string;
  label: string;
}

/**
 * A single entry in the unified mode/assist-strength select (design
 * 6.14.6): "Manual" / "Assist 25%" / "Assist 50%" / "Assist 75%" / "Auto".
 * This module only ever renders `id`/`label` -- what each id *means*
 * (which `DriveMode` and assist strength it maps to) is main.ts's concern,
 * kept out of this DOM-only layer like everywhere else in this file.
 */
export interface DriveModeOption {
  id: string;
  label: string;
}

export interface CourseOption {
  id: string;
  label: string;
}

export interface ThrottleBrakeSchemeOption {
  id: string;
  label: string;
}

/**
 * Android-only controls (design 6.15.3), bundled into one param instead of
 * growing createControls's positional-argument list further -- unlike the
 * other settings above, these six are only ever supplied together (all or
 * none, gated by `isTouchPrimary` on the caller's side via `matchMedia`).
 */
export interface AndroidControlsConfig {
  throttleBrakeSchemeOptions: ThrottleBrakeSchemeOption[];
  activeThrottleBrakeSchemeId: string;
  onThrottleBrakeSchemeSelect: (id: string) => void;
  onCalibrate: () => void;
  /** Fires with `true` when the menu opens, `false` when it closes (design 6.15.6/P14 follow-up) -- lets main.ts pause the drive while the settings panel is up, vfpv-pause-menu style. */
  onMenuToggle: (open: boolean) => void;
  onReset: () => void;
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
  initialMuted: boolean,
  onMuteToggle: (muted: boolean) => void,
  androidControls: AndroidControlsConfig | null,
): Controls {
  const root = document.createElement("div");
  // On a touch-primary device, anchor vertically centered on the right
  // edge instead of the bottom-left. The extra Android row (below) makes
  // this panel tall enough that bottom-left collides with
  // ui/touchPedals.ts's brake zone (also bottom-left) and swallows its
  // taps; top-right collides with ui/hud.ts's panel, which on a phone-width
  // screen is wide enough to reach most of the way across. The vertical
  // middle of the right edge is clear of both (found by testing on-device,
  // design 6.15.3).
  const corner = androidControls ? "right:12px;top:50%;transform:translateY(-50%);" : "left:12px;bottom:12px;";
  // On a touch-primary device this panel is opened from a menu button
  // instead of staying visible the whole time (design 6.15.3, vfpv's pause
  // menu), so it starts hidden -- via `display:none` in the inline style
  // itself, not the `hidden` attribute: the attribute's UA-stylesheet rule
  // is lower priority than any inline `display` declaration and would
  // silently lose to the `display:flex` below, leaving the panel visible
  // despite `hidden` being set (found by testing on-device).
  const display = androidControls ? "none" : "flex";
  root.style.cssText =
    `position:fixed;${corner}padding:10px 14px;background:rgba(0,0,0,0.55);` +
    `color:#fff;font:13px monospace;border-radius:6px;display:${display};flex-direction:column;gap:8px;z-index:10;`;

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

  // Drive mode + assist strength, unified into one live toggle (design
  // 6.14.6) like the camera select (not a navigation like course select).
  // A dropdown is fine here despite design 6.5's keyboard-only rule for
  // throttle/brake/steer -- this is a setting, not a driving input.
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

  // Android input (design 6.15.3): only rendered on a touch-primary device
  // (androidControls is null otherwise), so this has no effect on desktop's
  // existing layout.
  if (androidControls) {
    const schemeRow = document.createElement("label");
    schemeRow.style.cssText = "display:flex;align-items:center;gap:8px;";
    schemeRow.textContent = "throttle/brake";
    const schemeSelect = document.createElement("select");
    for (const option of androidControls.throttleBrakeSchemeOptions) {
      const el = document.createElement("option");
      el.value = option.id;
      el.textContent = option.label;
      if (option.id === androidControls.activeThrottleBrakeSchemeId) el.selected = true;
      schemeSelect.appendChild(el);
    }
    schemeSelect.addEventListener("change", () => androidControls.onThrottleBrakeSchemeSelect(schemeSelect.value));
    schemeRow.appendChild(schemeSelect);
    root.appendChild(schemeRow);

    const calibrateButton = document.createElement("button");
    calibrateButton.textContent = "calibrate tilt";
    calibrateButton.addEventListener("click", androidControls.onCalibrate);
    root.appendChild(calibrateButton);

    // No physical `R` key on Android (design 6.15.3), so the reset action
    // (requirement 4.7.4) needs a touch equivalent too.
    const resetButton = document.createElement("button");
    resetButton.textContent = "reset";
    resetButton.addEventListener("click", androidControls.onReset);
    root.appendChild(resetButton);
  }

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

  let muted = initialMuted;
  const muteButton = document.createElement("button");
  muteButton.textContent = muted ? "unmute" : "mute";
  muteButton.addEventListener("click", () => {
    muted = !muted;
    muteButton.textContent = muted ? "unmute" : "mute";
    onMuteToggle(muted);
  });
  root.appendChild(muteButton);

  parent.appendChild(root);

  // Menu button (design 6.15.3, P14 follow-up): on a touch-primary device,
  // the settings panel above is opened/closed from this small always-on
  // button instead of sitting on screen the whole time -- the same pattern
  // as vfpv's Android pause button (~/CCROOT/vfpv/scripts/pause_menu.gd).
  // Opening it also pauses the drive (design 6.15.6/P14 follow-up, via
  // `onMenuToggle`) -- vfpv's own pause menu does this too.
  if (androidControls) {
    const menuButton = document.createElement("button");
    menuButton.textContent = "☰";
    menuButton.style.cssText =
      "position:fixed;right:12px;top:12px;width:44px;height:44px;font-size:20px;" +
      "background:rgba(0,0,0,0.55);color:#fff;border:none;border-radius:6px;z-index:11;";
    menuButton.addEventListener("click", () => {
      const opening = root.style.display === "none";
      root.style.display = opening ? "flex" : "none";
      androidControls.onMenuToggle(opening);
    });
    parent.appendChild(menuButton);
  }

  return {
    setActiveCamera(id: string) {
      if (select.value !== id) select.value = id;
    },
    setActiveMode(id: string) {
      if (modeSelect.value !== id) modeSelect.value = id;
    },
  };
}
