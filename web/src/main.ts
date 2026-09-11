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
import { buildVehicleMesh } from "./render/vehicleMesh";
import { buildScenery } from "./render/scenery";
import { resetVehicle, stepVehicle, type VehicleInput, type VehicleState } from "./sim/vehicle";
import { DEFAULT_VEHICLE_PARAMS } from "./sim/vehicleParams";
import { computeAssist, type DriveMode } from "./sim/autopilot";
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
} from "./sim/input";
import { normalize, cross, rotateAroundAxis } from "./sim/vec";
import { CameraManager } from "./camera/manager";
import { ChaseRig } from "./camera/chaseRig";
import { CockpitRig } from "./camera/cockpitRig";
import type { VehiclePose } from "./camera/types";
import { EngineAudio } from "./audio/engine";
import { Hud } from "./ui/hud";
import { createControls, type DriveModeOption, type AssistStrengthOption } from "./ui/controls";
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

const DRIVE_MODE_OPTIONS: DriveModeOption[] = [
  { id: "auto", label: "Auto" },
  { id: "assist", label: "Assist" },
  { id: "manual", label: "Manual" },
];
function driveModeLabel(mode: DriveMode): string {
  if (mode === "auto") return "Auto";
  if (mode === "assist") return "Assist";
  return "Manual";
}
// Cycle order for the [M] key (design 6.14.5).
const DRIVE_MODE_CYCLE: DriveMode[] = ["auto", "assist", "manual"];
function nextDriveMode(mode: DriveMode): DriveMode {
  return DRIVE_MODE_CYCLE[(DRIVE_MODE_CYCLE.indexOf(mode) + 1) % DRIVE_MODE_CYCLE.length];
}

// Assist strength (design 6.14.1a, P12 follow-up): a setting, not a driving
// input (design 4.2.2), so it's UI-only -- no keyboard binding.
const ASSIST_STRENGTH_OPTIONS: AssistStrengthOption[] = [
  { id: "0", label: "0%" },
  { id: "0.25", label: "25%" },
  { id: "0.5", label: "50%" },
  { id: "0.75", label: "75%" },
  { id: "1", label: "100%" },
];
const DEFAULT_ASSIST_STRENGTH_ID = "0.5";

const DEBUG = new URLSearchParams(window.location.search).get("debug") === "1";
// design 6.10: `?course=<id>` picks which course/<id>.json to load, same
// query-parameter convention as `?debug=1`.
const COURSE_ID = new URLSearchParams(window.location.search).get("course") ?? DEFAULT_COURSE_ID;
const COURSE_URL = `/course/${COURSE_ID}.json`;

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
  scene.add(vehicleMesh);

  let vehicle: VehicleState = { s: 0, speed: 0, lap: 0, lateralOffset: 0, yaw: 0, steer: 0 };
  let driveMode: DriveMode = "auto"; // design 6.14.5: default preserves the P11 throttle-only experience
  let assistStrength = Number(DEFAULT_ASSIST_STRENGTH_ID); // design 6.14.1a, [0, 1]

  // design 6.14.1a: entering "assist" or "manual" from "auto" seeds the
  // driver-steer shaping state (below) at the car's current steer angle, so
  // driver control picks up smoothly instead of snapping from whatever the
  // auto assist last commanded.
  function enterDriverSteeredMode(next: DriveMode) {
    if (next !== "auto" && driveMode === "auto") shapedSteer = vehicle.steer;
    driveMode = next;
  }

  const cameraManager = new CameraManager([new ChaseRig(), new CockpitRig()]);
  cameraManager.init(camera, poseFor(track, vehicle));

  const engineAudio = new EngineAudio();
  const controls = createControls(
    document.body,
    cameraManager.list(),
    (id) => cameraManager.select(id),
    DRIVE_MODE_OPTIONS,
    (id) => {
      const next = DRIVE_MODE_OPTIONS.find((option) => option.id === id)?.id as DriveMode | undefined;
      if (next) enterDriverSteeredMode(next);
    },
    COURSE_CATALOG,
    COURSE_ID,
    selectCourse,
    (muted) => engineAudio.setMuted(muted),
    ASSIST_STRENGTH_OPTIONS,
    DEFAULT_ASSIST_STRENGTH_ID,
    (id) => {
      assistStrength = Number(id);
    },
  );
  const hud = new Hud(document.body, DEBUG, course.meta.name);

  const throttle = new KeyboardAxis(THROTTLE_KEYS);
  const brake = new KeyboardAxis(BRAKE_KEYS);
  const steerAxis = new KeyboardBipolarAxis(STEER_LEFT_KEYS, STEER_RIGHT_KEYS);
  const modeTrigger = new KeyTrigger(MODE_KEYS);
  const resetTrigger = new KeyTrigger(RESET_KEYS);
  // design 6.11: browsers keep a fresh AudioContext suspended until a user
  // gesture resumes it, so start the engine sound on the first keypress.
  window.addEventListener("keydown", () => engineAudio.start(), { once: true });

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
  let shapedSteer = 0; // driver-steer pre-ramp state ("manual"/"assist" only), see MANUAL_STEER_SHAPE_RATE above

  function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    const frameDt = Math.min(MAX_FRAME_DT, Math.max(0, (now - tPrev) / 1000));
    tPrev = now;
    accumulator += frameDt;

    if (modeTrigger.consume()) {
      enterDriverSteeredMode(nextDriveMode(driveMode));
      controls.setActiveMode(driveMode);
    }
    if (resetTrigger.consume()) {
      vehicle = resetVehicle(vehicle); // design 6.3.6: keeps s/lap, zeroes the rest
      shapedSteer = 0;
    }

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
    vehicleMesh.position.set(pose.position.x, pose.position.y, pose.position.z);
    vehicleMesh.up.set(pose.up.x, pose.up.y, pose.up.z);
    vehicleMesh.lookAt(
      pose.position.x + pose.forward.x,
      pose.position.y + pose.forward.y,
      pose.position.z + pose.forward.z,
    );

    const sample = track.sampleAt(vehicle.s);
    engineAudio.update({
      speed: vehicle.speed,
      throttle: throttle.read(),
      brake: brake.read(),
      gripExceeded: lastGripExceeded,
      onCurb: lastSurfaceKind === "curb",
      onGrass: lastSurfaceKind === "grass",
      wallContact: lastWallContact,
    });
    hud.update(
      {
        speedKmh: vehicle.speed * 3.6,
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
