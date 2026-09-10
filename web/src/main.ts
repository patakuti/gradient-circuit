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
import { ASPHALT_SURFACE, stepVehicle, type VehicleInput, type VehicleState } from "./sim/vehicle";
import { DEFAULT_VEHICLE_PARAMS } from "./sim/vehicleParams";
import { computeAssist, type DriveMode } from "./sim/autopilot";
import {
  KeyboardAxis,
  KeyboardBipolarAxis,
  KeyTrigger,
  THROTTLE_KEYS,
  BRAKE_KEYS,
  STEER_LEFT_KEYS,
  STEER_RIGHT_KEYS,
  MODE_KEYS,
} from "./sim/input";
import { normalize, cross, rotateAroundAxis } from "./sim/vec";
import { CameraManager } from "./camera/manager";
import { ChaseRig } from "./camera/chaseRig";
import { CockpitRig } from "./camera/cockpitRig";
import type { VehiclePose } from "./camera/types";
import { EngineAudio } from "./audio/engine";
import { Hud } from "./ui/hud";
import { createControls, type DriveModeOption } from "./ui/controls";
import { COURSE_CATALOG, DEFAULT_COURSE_ID } from "./course/catalog";

const FIXED_DT = 1 / 120; // design 6.4: physics runs at a fixed timestep
const MAX_FRAME_DT = 0.1; // clamp huge dt after e.g. a backgrounded tab
const LOOKAHEAD_M = 25; // design 6.6: cockpitRig's corner look-ahead distance

// Manual-mode-only steer shaping (design 6.3.7 follow-up): a driver
// reported full-lock feeling too sharp/twitchy on keyboard. sim/vehicle.ts's
// own steerRate can't be slowed to fix this -- it's shared with the auto
// assist (design 6.14.4), and a sweep confirmed slowing it badly breaks the
// assist's ability to track fast corners (Monaco's road-edge excursion
// jumped from 0.76 m to 170+ m at steerRate=1.5). Instead, the raw -1/0/+1
// key command is smoothed *before* it reaches stepVehicle, only in manual
// mode -- vehicle.ts's own ramp (fast, auto-mode-tuned) then tracks this
// already-gentle target closely, so the felt response is dominated by this
// slower stage without touching the shared physical model. Full lock is
// still reachable (unlike scaling the command's magnitude down), just
// takes longer to ramp into -- preserves the ability to make the
// tightest hairpin if committed to early.
const MANUAL_STEER_SHAPE_RATE = 1.2; // 1/s, engaging
const MANUAL_STEER_SHAPE_RETURN_RATE = 1.8; // 1/s, releasing

function moveToward(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(current + maxDelta, target);
  if (current > target) return Math.max(current - maxDelta, target);
  return current;
}

const DRIVE_MODE_OPTIONS: DriveModeOption[] = [
  { id: "auto", label: "Auto" },
  { id: "manual", label: "Manual" },
];
function driveModeLabel(mode: DriveMode): string {
  return mode === "auto" ? "Auto" : "Manual";
}

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
  const lookahead = track.positionAt(state.s + LOOKAHEAD_M, state.lateralOffset);
  return {
    position,
    forward,
    up: sample.up,
    right,
    lookahead,
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
  // design 6.7/6.12: the plain guardrail barrier is a stand-in for a street
  // course's real Armco (Monaco); a permanent circuit's curb/grass/trees
  // (render/circuitScenery.ts) already serve that role, so skip the
  // redundant grey wall there.
  if (courseOption.kind === "street") scene.add(buildBarriers(track));
  scene.add(buildScenery(track, courseOption));
  const vehicleMesh = buildVehicleMesh();
  scene.add(vehicleMesh);

  let vehicle: VehicleState = { s: 0, speed: 0, lap: 0, lateralOffset: 0, yaw: 0, steer: 0 };
  let driveMode: DriveMode = "auto"; // design 6.14.5: default preserves the P11 throttle-only experience

  const cameraManager = new CameraManager([new ChaseRig(), new CockpitRig()]);
  cameraManager.init(camera, poseFor(track, vehicle));

  const engineAudio = new EngineAudio();
  const controls = createControls(
    document.body,
    cameraManager.list(),
    (id) => cameraManager.select(id),
    DRIVE_MODE_OPTIONS,
    (id) => {
      const next: DriveMode = id === "manual" ? "manual" : "auto";
      if (next === "manual" && driveMode !== "manual") manualSteerShaped = vehicle.steer;
      driveMode = next;
    },
    COURSE_CATALOG,
    COURSE_ID,
    selectCourse,
    (muted) => engineAudio.setMuted(muted),
  );
  const hud = new Hud(document.body, DEBUG, course.meta.name);

  const throttle = new KeyboardAxis(THROTTLE_KEYS);
  const brake = new KeyboardAxis(BRAKE_KEYS);
  const steerAxis = new KeyboardBipolarAxis(STEER_LEFT_KEYS, STEER_RIGHT_KEYS);
  const modeTrigger = new KeyTrigger(MODE_KEYS);
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
  let manualSteerShaped = 0; // manual-mode-only pre-ramp state, see MANUAL_STEER_SHAPE_RATE above

  function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    const frameDt = Math.min(MAX_FRAME_DT, Math.max(0, (now - tPrev) / 1000));
    tPrev = now;
    accumulator += frameDt;

    if (modeTrigger.consume()) {
      const next: DriveMode = driveMode === "auto" ? "manual" : "auto";
      if (next === "manual") manualSteerShaped = vehicle.steer;
      driveMode = next;
      controls.setActiveMode(driveMode);
    }

    const lapBefore = vehicle.lap;
    while (accumulator >= FIXED_DT) {
      const stepSample = track.sampleAt(vehicle.s);
      // design 6.14.1: the assist never bypasses the vehicle model -- its
      // output is mixed into the same VehicleInput a human's keys produce,
      // so it is subject to the same steer-rate ramp and grip limits.
      const input: VehicleInput =
        driveMode === "auto"
          ? (() => {
              const assist = computeAssist(track, vehicle, DEFAULT_VEHICLE_PARAMS, ASPHALT_SURFACE);
              return {
                throttle: assist.throttleCut ? 0 : throttle.read(),
                brake: Math.max(brake.read(), assist.brake),
                steer: assist.steer,
              };
            })()
          : (() => {
              const shapeRate = steerAxis.read() === 0 ? MANUAL_STEER_SHAPE_RETURN_RATE : MANUAL_STEER_SHAPE_RATE;
              manualSteerShaped = moveToward(manualSteerShaped, steerAxis.read(), shapeRate * FIXED_DT);
              return { throttle: throttle.read(), brake: brake.read(), steer: manualSteerShaped };
            })();

      const result = stepVehicle(
        vehicle,
        input,
        stepSample.grade,
        stepSample.curvature,
        ASPHALT_SURFACE, // P13 replaces this with sim/surface.ts's surfaceAt() result
        FIXED_DT,
        DEFAULT_VEHICLE_PARAMS,
        track.length,
      );
      vehicle = result.state;
      lastGripExceeded = result.gripExceeded;
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
