/**
 * Application entry point: scene/camera/renderer setup and the composition
 * root. Per design 6.1, this file only wires modules together -- no
 * simulation or rendering logic of its own.
 *
 * P12 status: steering (design 6.3), the "auto"/"manual" drive mode
 * (design 6.14) and the resulting HUD/audio fields replace P4-P11's
 * throttle-only, always-centerline driving. `?debug=1` adds the
 * s/curvature/width/lateralOffset/yaw/grip/fps panel (design 6.9).
 */

import * as THREE from "three";
import { loadCourse } from "./course/loader";
import { Track } from "./sim/track";
import { buildTrackMesh } from "./render/trackMesh";
import { buildBarriers } from "./render/barrier";
import { setupEnvironment } from "./render/environment";
import { buildVehicleMesh, WHEEL_RADIUS } from "./render/vehicleMesh";
import { buildScenery } from "./render/scenery";
import { maxSteerAngleAt, resetVehicle, stepVehicle, type VehicleInput, type VehicleState } from "./sim/vehicle";
import { DEFAULT_VEHICLE_PARAMS, DEFAULT_SHIFT_PARAMS } from "./sim/vehicleParams";
import { updateGear, INITIAL_GEAR } from "./sim/shiftModel";
import { computeAssist, cornerGripSpeed, type DriveMode } from "./sim/autopilot";
import { surfaceAt, type SurfaceKind } from "./sim/surface";
import {
  KeyboardAxis,
  KeyboardBipolarAxis,
  KeyTrigger,
  THROTTLE_KEYS,
  BRAKE_KEYS,
  STEER_LEFT_KEYS,
  STEER_RIGHT_KEYS,
  MODE_KEYS,
  RESET_KEYS,
  type AxisSource,
  type BipolarAxisSource,
} from "./sim/input";
import { TiltSensor, TiltSteerAxis, TiltThrottleAxis, TiltBrakeAxis } from "./sim/tiltInput";
import { createTouchPedals, type TouchPedals } from "./ui/touchPedals";
import { normalize, cross, rotateAroundAxis } from "./sim/vec";
import { CameraManager } from "./camera/manager";
import { ChaseRig } from "./camera/chaseRig";
import { CockpitRig } from "./camera/cockpitRig";
import type { VehiclePose } from "./camera/types";
import { EngineAudio } from "./audio/engine";
import { Hud } from "./ui/hud";
import { Gauges } from "./ui/gauges";
import {
  createControls,
  type DriveModeOption,
  type ThrottleBrakeSchemeOption,
  type AndroidControlsConfig,
} from "./ui/controls";
import { COURSE_CATALOG, DEFAULT_COURSE_ID } from "./course/catalog";

const FIXED_DT = 1 / 120; // design 6.4: physics runs at a fixed timestep
const MAX_FRAME_DT = 0.1; // clamp huge dt after e.g. a backgrounded tab

// Driver-steer-input shaping (design 6.3.7 follow-up, extended to "assist"
// mode by design 6.14.1a): a driver reported full-lock feeling too
// sharp/twitchy on keyboard. sim/vehicle.ts's own steerRate can't be slowed
// to fix this -- it's shared with the auto assist (design 6.14.4), and a
// sweep confirmed slowing it badly breaks the assist's ability to track
// fast corners (Monaco's road-edge excursion jumped from 0.76 m to 170+ m
// at steerRate=1.5). Instead, the raw -1/0/+1 key command is smoothed
// *before* it reaches stepVehicle, in any mode where the driver's own
// steering is used ("manual" and "assist") -- vehicle.ts's own ramp (fast,
// auto-mode-tuned) then tracks this already-gentle target closely, so the
// felt response is dominated by this slower stage without touching the
// shared physical model. Full lock is still reachable (unlike scaling the
// command's magnitude down), just takes longer to ramp into -- preserves
// the ability to make the tightest hairpin if committed to early.
const MANUAL_STEER_SHAPE_RATE = 1.2; // 1/s, engaging
const MANUAL_STEER_SHAPE_RETURN_RATE = 1.8; // 1/s, releasing

function moveToward(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(current + maxDelta, target);
  if (current > target) return Math.max(current - maxDelta, target);
  return current;
}

// Mode + assist strength, unified into a single spectrum (design 6.14.6
// follow-up): the old 3-mode select plus a separately-enabled 0-100% assist
// select let you dial in "assist" at 0% or 100%, which duplicate "manual"
// and "auto" respectively (0% is bit-for-bit the same input mix as manual;
// 100% is *almost* the same as auto, short of auto's corner-approach
// throttle cut -- see design 6.14.1a/6.14.6) without reading as such in the
// UI. One control with five non-overlapping steps removes that redundancy.
interface CombinedModeOption extends DriveModeOption {
  mode: DriveMode;
  strength: number; // meaningful only when mode === "assist"; carried for manual/auto too so callers need no special case
}
const COMBINED_MODE_OPTIONS: CombinedModeOption[] = [
  { id: "manual", label: "Manual", mode: "manual", strength: 0 },
  { id: "assist25", label: "Assist 25%", mode: "assist", strength: 0.25 },
  { id: "assist50", label: "Assist 50%", mode: "assist", strength: 0.5 },
  { id: "assist75", label: "Assist 75%", mode: "assist", strength: 0.75 },
  { id: "auto", label: "Auto", mode: "auto", strength: 1 },
];
const DEFAULT_COMBINED_MODE_ID = "auto"; // design 6.14.5 acceptance criterion #9: throttle-only lap on first launch
function combinedModeOption(id: string): CombinedModeOption {
  return COMBINED_MODE_OPTIONS.find((option) => option.id === id) ?? COMBINED_MODE_OPTIONS[COMBINED_MODE_OPTIONS.length - 1];
}
function driveModeLabel(mode: DriveMode): string {
  if (mode === "auto") return "Auto";
  if (mode === "assist") return "Assist";
  return "Manual";
}
// Cycle order for the [M] key (design 6.14.6): most- to least-automated,
// same direction as the pre-unification auto -> assist -> manual cycle.
const COMBINED_MODE_CYCLE = ["auto", "assist75", "assist50", "assist25", "manual"];
function nextCombinedModeId(id: string): string {
  return COMBINED_MODE_CYCLE[(COMBINED_MODE_CYCLE.indexOf(id) + 1) % COMBINED_MODE_CYCLE.length];
}

// Android input (design 6.15): `(pointer: coarse)` is the standard way to
// detect a touch-primary device (unlike `"ontouchstart" in window`, which
// is also true on some mouse-primary laptops with a touchscreen).
const IS_TOUCH_PRIMARY = window.matchMedia("(pointer: coarse)").matches;

const THROTTLE_BRAKE_SCHEME_OPTIONS: ThrottleBrakeSchemeOption[] = [
  { id: "touch", label: "Touch pedals" },
  { id: "tilt", label: "Tilt" },
];
const DEFAULT_THROTTLE_BRAKE_SCHEME_ID = "touch";

// Settings persistence (design 6.10 follow-up): course switching is a full
// navigation (reloads with a new `?course=`, since the whole world -- track
// mesh, scenery, barriers -- changes), and a page reload with no persistence
// would silently reset every setting below back to its hardcoded default.
// The vehicle's *drive* state (position/speed/lap) resetting on a course
// change is correct -- you can't keep driving on the old track's position on
// a new one -- but the driver's chosen mode/assist/camera/mute/input-scheme
// preferences should survive it, the same way they already survive a plain
// page refresh on the same course.
function loadSetting(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage unavailable -- the selection just won't persist across reloads
  }
}

const THROTTLE_BRAKE_SCHEME_STORAGE_KEY = "gradient-circuit:throttleBrakeScheme";
function loadThrottleBrakeScheme(): string {
  return loadSetting(THROTTLE_BRAKE_SCHEME_STORAGE_KEY, DEFAULT_THROTTLE_BRAKE_SCHEME_ID);
}
// Persists the choice for next launch; main()'s applyThrottleBrakeScheme
// (P14 follow-up) hot-swaps the actual axis instances live, so this no
// longer reloads the page -- an earlier version did, which reset the whole
// drive (lap/position/speed) just from changing a setting.
function saveThrottleBrakeScheme(id: string): void {
  saveSetting(THROTTLE_BRAKE_SCHEME_STORAGE_KEY, id);
}

// Key kept from the pre-unification separate "driveMode" setting (design
// 6.10 follow-up) -- same concern, now a single combined-mode id instead of
// a bare DriveMode; a stale value from before this change (e.g. "assist")
// just won't match any current id and falls back to the default, same as
// any other unrecognized value.
const DRIVE_MODE_STORAGE_KEY = "gradient-circuit:driveMode";
function loadCombinedModeId(): string {
  const saved = loadSetting(DRIVE_MODE_STORAGE_KEY, DEFAULT_COMBINED_MODE_ID);
  return COMBINED_MODE_OPTIONS.some((option) => option.id === saved) ? saved : DEFAULT_COMBINED_MODE_ID;
}
function saveCombinedModeId(id: string): void {
  saveSetting(DRIVE_MODE_STORAGE_KEY, id);
}

const CAMERA_STORAGE_KEY = "gradient-circuit:camera";
function loadCameraId(): string | null {
  try {
    return localStorage.getItem(CAMERA_STORAGE_KEY);
  } catch {
    return null;
  }
}
function saveCameraId(id: string): void {
  saveSetting(CAMERA_STORAGE_KEY, id);
}

const MUTED_STORAGE_KEY = "gradient-circuit:muted";
function loadMuted(): boolean {
  return loadSetting(MUTED_STORAGE_KEY, "0") === "1";
}
function saveMuted(muted: boolean): void {
  saveSetting(MUTED_STORAGE_KEY, muted ? "1" : "0");
}

const DEBUG = new URLSearchParams(window.location.search).get("debug") === "1";
// design 6.10: `?course=<id>` picks which course/<id>.json to load, same
// query-parameter convention as `?debug=1`.
const COURSE_ID = new URLSearchParams(window.location.search).get("course") ?? DEFAULT_COURSE_ID;
// Relative (no leading "/") so it resolves correctly whether the app is
// served from the domain root (dev, Capacitor) or a subpath (a GitHub
// Pages project page, e.g. /gradient-circuit/) -- P20, verified below.
const COURSE_URL = `course/${COURSE_ID}.json`;

function selectCourse(id: string): void {
  const params = new URLSearchParams(window.location.search);
  params.set("course", id);
  window.location.search = params.toString();
}

function createScene(): { scene: THREE.Scene; camera: THREE.PerspectiveCamera; renderer: THREE.WebGLRenderer } {
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.1,
    5000,
  );

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);

  const app = document.getElementById("app");
  if (!app) throw new Error("#app element not found");
  app.appendChild(renderer.domElement);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { scene, camera, renderer };
}

function poseFor(track: Track, state: VehicleState): VehiclePose {
  const sample = track.sampleAt(state.s);
  const position = track.positionAt(state.s, state.lateralOffset);
  // The car body's facing direction: the track tangent rotated by yaw
  // around the track's own up axis (design 6.3.1). Rotating a small
  // positive angle turns the tangent toward cross(up, tangent) -- the same
  // formula sim/track.ts's `normal` is built from -- so this stays
  // consistent with yaw/lateralOffset's shared "positive = left" sign
  // convention without needing a separate sign flip here.
  const forward = normalize(rotateAroundAxis(sample.tangent, sample.up, state.yaw));
  const right = normalize(cross(sample.tangent, sample.up));
  return {
    position,
    forward,
    up: sample.up,
    right,
    speed: state.speed,
    s: state.s,
    lap: state.lap,
  };
}

// Landscape lock (design 6.15.6, P14 follow-up): the Capacitor app locks
// via AndroidManifest.xml's `android:screenOrientation="landscape"`, which
// isn't available to a plain mobile-browser tab, so also try the Web API
// here as a best-effort fallback -- browsers commonly refuse this outside
// fullscreen, so a failure is silently ignored rather than surfaced.
if (IS_TOUCH_PRIMARY) {
  // TypeScript's DOM lib doesn't declare ScreenOrientation.lock() (it's
  // supported by Chrome/Android despite that).
  const orientation = screen.orientation as ScreenOrientation & { lock?: (type: string) => Promise<void> };
  orientation.lock?.("landscape")?.catch(() => {});
}

async function main() {
  const { scene, camera, renderer } = createScene();

  const course = await loadCourse(COURSE_URL);
  console.log(
    `[course] loaded "${course.meta.name}" (${course.meta.event} ${course.meta.year} ` +
      `${course.meta.session}): ${course.count} samples, length=${course.length.toFixed(1)}m, ` +
      `closed=${course.closed}, bank_source=${course.meta.bank_source}`,
  );

  const track = Track.from(course);
  setupEnvironment(scene, track);
  scene.add(buildTrackMesh(track));
  const courseOption = COURSE_CATALOG.find((option) => option.id === COURSE_ID) ?? COURSE_CATALOG[0];
  // design 6.13.3/6.7 (P13 follow-up): the barrier is now drawn for every
  // course kind, at sim/surface.ts's barrierOffsetAt() -- for a permanent
  // circuit that's a full grass-width beyond the curb/grass/trees (render/
  // circuitScenery.ts), not right next to them, so it reads as a distant
  // boundary rather than the redundant grey wall P11 removed.
  scene.add(buildBarriers(track, courseOption.kind));
  scene.add(buildScenery(track, courseOption));
  const vehicleMesh = buildVehicleMesh();
  scene.add(vehicleMesh.group);

  let vehicle: VehicleState = { s: 0, speed: 0, lap: 0, lateralOffset: 0, yaw: 0, steer: 0 };
  // design 6.14.5/6.14.6 default is "auto"; persisted so a course change doesn't reset it
  let combinedModeId = loadCombinedModeId();
  let driveMode: DriveMode = combinedModeOption(combinedModeId).mode;
  let assistStrength = combinedModeOption(combinedModeId).strength; // design 6.14.1a, [0, 1]
  let shapedSteer = 0; // driver-steer pre-ramp state ("manual"/"assist" only), see MANUAL_STEER_SHAPE_RATE above
  // design 6.15.6 follow-up: true while the Android settings menu is open.
  // Freezes the physics step and engine sound in animate() below -- desktop
  // never sets this (no menu button there, see ui/controls.ts).
  let paused = false;

  // design 6.14.1a/6.14.6: entering "assist" or "manual" from "auto" seeds
  // the driver-steer shaping state (below) at the car's current steer
  // angle, so driver control picks up smoothly instead of snapping from
  // whatever the auto assist last commanded.
  function enterCombinedMode(nextId: string) {
    const next = combinedModeOption(nextId);
    if (next.mode !== "auto" && driveMode === "auto") shapedSteer = vehicle.steer;
    combinedModeId = nextId;
    driveMode = next.mode;
    assistStrength = next.strength;
    saveCombinedModeId(nextId);
  }

  // design 6.3.6/6.15.3: shared by the `R` key (KeyTrigger below) and
  // Android's on-screen reset button, which has no physical key to bind to.
  function doReset() {
    vehicle = resetVehicle(vehicle); // keeps s/lap, zeroes the rest
    shapedSteer = 0;
    // design 6.16: snap straight to 1st rather than letting updateGear()
    // cascade down one gear per frame from whatever it was before the
    // reset (it only ever moves by one gear per call).
    currentGear = INITIAL_GEAR;
  }

  // onChange persists the driver's viewpoint from wherever it changes --
  // the UI dropdown *and* the `C` key (design 6.10 follow-up; the latter
  // used to go untracked, so cycling cameras with `C` and then switching
  // course silently reverted to the default view on reload).
  const cameraManager = new CameraManager([new ChaseRig(), new CockpitRig()], saveCameraId);
  cameraManager.init(camera, poseFor(track, vehicle));
  // Restores the driver's chosen viewpoint across a course change (design
  // 6.10 follow-up); select() no-ops silently on an unknown/missing id, so
  // a first-ever launch (nothing saved yet) just keeps init()'s default.
  const savedCameraId = loadCameraId();
  if (savedCameraId) cameraManager.select(savedCameraId);

  const engineAudio = new EngineAudio();
  engineAudio.setMuted(loadMuted()); // takes effect once start() runs (first keydown/touchstart)

  // Input axes (design 6.15.2): on a touch-primary device, steer always
  // comes from device tilt (auto mode ignores it just like keyboard steer,
  // design 6.14.5); throttle/brake come from whichever scheme is selected,
  // and can be switched live (P14 follow-up) without losing the drive in
  // progress -- both the tilt sensor and the touch pedals are created once
  // up front and applyThrottleBrakeScheme() below just reassigns which one
  // `throttle`/`brake` point to, instead of the page reloading.
  // On desktop these stay the keyboard axes P12 already had.
  let throttle: AxisSource;
  let brake: AxisSource;
  let steerAxis: BipolarAxisSource;
  let tiltSensor: TiltSensor | null = null;
  let touchPedals: TouchPedals | null = null;

  function applyThrottleBrakeScheme(id: string): void {
    if (id === "tilt" && tiltSensor) {
      throttle = new TiltThrottleAxis(tiltSensor);
      brake = new TiltBrakeAxis(tiltSensor);
      touchPedals?.setVisible(false);
    } else if (touchPedals) {
      throttle = touchPedals.throttle;
      brake = touchPedals.brake;
      touchPedals.setVisible(true);
    }
  }

  if (IS_TOUCH_PRIMARY) {
    tiltSensor = new TiltSensor();
    steerAxis = new TiltSteerAxis(tiltSensor);
    touchPedals = createTouchPedals(document.body);
    throttle = touchPedals.throttle; // placeholder until applyThrottleBrakeScheme runs below; always reassigned before use
    brake = touchPedals.brake;
    applyThrottleBrakeScheme(loadThrottleBrakeScheme());
  } else {
    throttle = new KeyboardAxis(THROTTLE_KEYS);
    brake = new KeyboardAxis(BRAKE_KEYS);
    steerAxis = new KeyboardBipolarAxis(STEER_LEFT_KEYS, STEER_RIGHT_KEYS);
  }

  const androidControls: AndroidControlsConfig | null = IS_TOUCH_PRIMARY
    ? {
        throttleBrakeSchemeOptions: THROTTLE_BRAKE_SCHEME_OPTIONS,
        activeThrottleBrakeSchemeId: loadThrottleBrakeScheme(),
        onThrottleBrakeSchemeSelect: (id) => {
          saveThrottleBrakeScheme(id);
          applyThrottleBrakeScheme(id);
        },
        onCalibrate: () => tiltSensor?.calibrate(),
        onReset: doReset,
        onMenuToggle: (open) => {
          paused = open;
          // The settings panel (ui/controls.ts) is vertically centered on
          // the right and would otherwise sit on top of the top-right
          // gauges (P19 follow-up, found via emulator screenshot).
          gauges.setVisible(!open);
        },
      }
    : null;

  const controls = createControls(
    document.body,
    cameraManager.list(),
    (id) => cameraManager.select(id), // persistence now goes through CameraManager's onChange above
    COMBINED_MODE_OPTIONS,
    (id) => enterCombinedMode(id),
    COURSE_CATALOG,
    COURSE_ID,
    selectCourse,
    loadMuted(),
    (muted) => {
      engineAudio.setMuted(muted);
      saveMuted(muted);
    },
    androidControls,
  );
  controls.setActiveMode(combinedModeId); // syncs the dropdown with the persisted mode (design 6.10 follow-up)
  const hud = new Hud(document.body, DEBUG, course.meta.name, IS_TOUCH_PRIMARY);
  const gauges = new Gauges(document.body, IS_TOUCH_PRIMARY);

  const modeTrigger = new KeyTrigger(MODE_KEYS);
  const resetTrigger = new KeyTrigger(RESET_KEYS);
  // design 6.11: browsers keep a fresh AudioContext suspended until a user
  // gesture resumes it, so start the engine sound on the first keypress --
  // or, on Android where there's no keyboard, the first touch.
  window.addEventListener("keydown", () => engineAudio.start(), { once: true });
  window.addEventListener("touchstart", () => engineAudio.start(), { once: true, passive: true });

  let tPrev = performance.now();
  let accumulator = 0;
  let simTime = 0;
  let lastLapStartTime = 0;
  let lastLapTimeS: number | null = null;
  // design 6.4: audio/HUD use the *last* physics step's result for a
  // frame, not an OR across every step that ran, to avoid flicker when
  // multiple steps land in one frame.
  let lastGripExceeded = false;
  let lastSurfaceKind: SurfaceKind = "asphalt";
  // Separate from lastSurfaceKind: surfaceAt() classifies by the vehicle's
  // *center* position, but stepVehicle's wall stop is now offset inward by
  // vehicleHalfWidth (design 6.3.5 follow-up) so the body's outer edge, not
  // its center, reaches the wall -- meaning the center often never crosses
  // into surfaceAt's own "wall" band. wallContact is the actual contact
  // event from the physics step, so it -- not surface.kind -- is the right
  // signal for "currently at the wall".
  let lastWallContact = false;
  // design 6.16/P17: updated once per frame (not per fixed physics step,
  // design 6.4) since gear/RPM never feed back into physics.
  let currentGear = INITIAL_GEAR;

  function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    const frameDt = Math.min(MAX_FRAME_DT, Math.max(0, (now - tPrev) / 1000));
    tPrev = now;
    // While paused, `frameDt` is deliberately never added to `accumulator`
    // (design 6.15.6 follow-up) -- otherwise the physics loop below would
    // "owe" every second spent in the menu and burn through it in a burst
    // of steps the instant the menu closes, exactly the runaway-catch-up
    // failure MAX_FRAME_DT already guards against for a single frame.
    if (!paused) accumulator += frameDt;

    if (modeTrigger.consume()) {
      enterCombinedMode(nextCombinedModeId(combinedModeId));
      controls.setActiveMode(combinedModeId);
    }
    if (resetTrigger.consume()) doReset();

    const lapBefore = vehicle.lap;
    while (accumulator >= FIXED_DT) {
      const stepSample = track.sampleAt(vehicle.s);
      // design 6.4/6.13: surface is read fresh every physics step (not once
      // per frame) so a fast pass across the road edge can't skip it.
      const surface = surfaceAt(courseOption.kind, stepSample, vehicle.lateralOffset);
      // design 6.14.1: the assist never bypasses the vehicle model -- its
      // output is mixed into the same VehicleInput a human's keys produce,
      // so it is subject to the same steer-rate ramp and grip limits.
      const input: VehicleInput = (() => {
        if (driveMode === "auto") {
          const assist = computeAssist(track, vehicle, DEFAULT_VEHICLE_PARAMS, surface);
          return {
            throttle: assist.throttleCut ? 0 : throttle.read(),
            brake: Math.max(brake.read(), assist.brake),
            steer: assist.steer,
          };
        }
        const shapeRate = steerAxis.read() === 0 ? MANUAL_STEER_SHAPE_RETURN_RATE : MANUAL_STEER_SHAPE_RATE;
        shapedSteer = moveToward(shapedSteer, steerAxis.read(), shapeRate * FIXED_DT);
        if (driveMode === "manual") {
          return { throttle: throttle.read(), brake: brake.read(), steer: shapedSteer };
        }
        // design 6.14.1a: "assist" blends computeAssist's output into the
        // driver's own (already-shaped) input instead of replacing it --
        // throttle stays fully the driver's, brake only ever adds on top of
        // the driver's own braking, steer is a straight lerp by strength.
        const assist = computeAssist(track, vehicle, DEFAULT_VEHICLE_PARAMS, surface);
        return {
          throttle: throttle.read(),
          brake: Math.max(brake.read(), assistStrength * assist.brake),
          steer: shapedSteer + assistStrength * (assist.steer - shapedSteer),
        };
      })();

      const result = stepVehicle(
        vehicle,
        input,
        stepSample.grade,
        stepSample.curvature,
        surface,
        FIXED_DT,
        DEFAULT_VEHICLE_PARAMS,
        track.length,
      );
      vehicle = result.state;
      lastGripExceeded = result.gripExceeded;
      lastSurfaceKind = surface.kind;
      lastWallContact = result.wallContact;
      accumulator -= FIXED_DT;
      simTime += FIXED_DT;
    }
    if (vehicle.lap !== lapBefore) {
      lastLapTimeS = simTime - lastLapStartTime;
      lastLapStartTime = simTime;
      console.log(`[vehicle] lap ${vehicle.lap} complete in ${lastLapTimeS.toFixed(3)}s`);
    }

    const pose = poseFor(track, vehicle);
    cameraManager.update(camera, pose, frameDt);
    controls.setActiveCamera(cameraManager.current.id);

    // design 6.8: same position/orientation technique as the camera rigs
    // (chaseRig.ts/cockpitRig.ts) -- set `up` before lookAt so it uses ours.
    vehicleMesh.group.position.set(pose.position.x, pose.position.y, pose.position.z);
    vehicleMesh.group.up.set(pose.up.x, pose.up.y, pose.up.z);
    vehicleMesh.group.lookAt(
      pose.position.x + pose.forward.x,
      pose.position.y + pose.forward.y,
      pose.position.z + pose.forward.z,
    );

    // design 6.8.1: front wheel steer angle, display-only (doesn't feed
    // back into stepVehicle). Reuses the same function the physics model
    // itself uses for the steer limit, so the visible angle matches the
    // number driving the actual grip/curvature model.
    const steerAngle = maxSteerAngleAt(vehicle.speed, DEFAULT_VEHICLE_PARAMS) * vehicle.steer;
    for (const pivot of vehicleMesh.frontSteerPivots) pivot.rotation.y = steerAngle;

    const sample = track.sampleAt(vehicle.s);
    // design 6.16/P17: frame-rate cadence, not the fixed physics step --
    // gear/RPM never feed back into stepVehicle (requirement 4.9).
    const shift = updateGear(currentGear, vehicle.speed, DEFAULT_SHIFT_PARAMS);
    currentGear = shift.gear;
    // Paused: skip the engine/tire audio, gauge updates, and wheel-roll
    // animation too, so they freeze with the drive instead of still
    // revving/spinning to whatever the driver's tilt/pedal happens to read
    // while the menu covers them (design 6.15.6 follow-up).
    if (!paused) {
      const rollDelta = (vehicle.speed * frameDt) / WHEEL_RADIUS;
      for (const axle of vehicleMesh.wheelAxles) axle.rotation.x += rollDelta;

      engineAudio.update({
        speed: vehicle.speed,
        rpm: shift.rpm,
        idleRpm: DEFAULT_SHIFT_PARAMS.idleRpm,
        redlineRpm: DEFAULT_SHIFT_PARAMS.redlineRpm,
        throttle: throttle.read(),
        brake: brake.read(),
        gripExceeded: lastGripExceeded,
        onCurb: lastSurfaceKind === "curb",
        onGrass: lastSurfaceKind === "grass",
        wallContact: lastWallContact,
      });
      gauges.update(
        vehicle.speed * 3.6, shift.rpm, shift.gear,
        DEFAULT_SHIFT_PARAMS.idleRpm, DEFAULT_SHIFT_PARAMS.redlineRpm,
      );
    }
    hud.update(
      {
        speedKmh: vehicle.speed * 3.6,
        gear: shift.gear,
        throttlePercent: throttle.read() * 100,
        brakePercent: brake.read() * 100,
        steerPercent: vehicle.steer * 100,
        elevationM: pose.position.y,
        gradePercent: Math.sin(sample.grade) * 100,
        lap: vehicle.lap,
        lapDistanceM: vehicle.s,
        lastLapTimeS,
        driveModeLabel: driveModeLabel(driveMode),
        assistStrengthPercent: driveMode === "assist" ? assistStrength * 100 : null,
        surfaceLabel: lastWallContact ? "wall" : lastSurfaceKind,
        cameraLabel: cameraManager.current.label,
      },
      DEBUG
        ? {
            s: sample.s,
            curvature: sample.curvature,
            widthLeft: sample.widthLeft,
            widthRight: sample.widthRight,
            lateralOffset: vehicle.lateralOffset,
            yawDeg: (vehicle.yaw * 180) / Math.PI,
            gripExceeded: lastGripExceeded,
            // design 6.9/P15, debug-only: recomputed fresh here (not the
            // physics substep's `surface`, out of scope by this point)
            // purely for display -- negligible cost once per frame.
            referenceSpeedKmh: sample.referenceSpeed * 3.6,
            targetSpeedKmh:
              Math.min(
                sample.referenceSpeed,
                cornerGripSpeed(
                  sample.curvature,
                  surfaceAt(courseOption.kind, sample, vehicle.lateralOffset).gripFactor,
                  DEFAULT_VEHICLE_PARAMS,
                ),
              ) * 3.6,
            fps: frameDt > 0 ? 1 / frameDt : 0,
          }
        : undefined,
    );

    renderer.render(scene, camera);
  }
  animate();
}

main().catch((err) => {
  console.error("[main] failed to start:", err);
});
