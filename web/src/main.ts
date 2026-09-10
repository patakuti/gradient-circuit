/**
 * Application entry point: scene/camera/renderer setup and the composition
 * root. Per design 6.1, this file only wires modules together -- no
 * simulation or rendering logic of its own.
 *
 * P6 status: the real HUD/controls (ui/hud.ts, ui/controls.ts) replace the
 * P4/P5 temporary overlay. `?debug=1` adds the s/curvature/width/fps panel
 * (design 03_plan.md P6).
 */

import * as THREE from "three";
import { loadCourse } from "./course/loader";
import { Track } from "./sim/track";
import { buildTrackMesh } from "./render/trackMesh";
import { buildBarriers } from "./render/barrier";
import { setupEnvironment } from "./render/environment";
import { buildVehicleMesh } from "./render/vehicleMesh";
import { buildScenery } from "./render/scenery";
import { stepVehicle, cornerSpeedLimit, type VehicleState } from "./sim/vehicle";
import { DEFAULT_VEHICLE_PARAMS } from "./sim/vehicleParams";
import { KeyboardAxis, THROTTLE_KEYS, BRAKE_KEYS } from "./sim/input";
import { normalize, cross } from "./sim/vec";
import { CameraManager } from "./camera/manager";
import { ChaseRig } from "./camera/chaseRig";
import { CockpitRig } from "./camera/cockpitRig";
import type { VehiclePose } from "./camera/types";
import { EngineAudio } from "./audio/engine";
import { Hud } from "./ui/hud";
import { createControls } from "./ui/controls";
import { COURSE_CATALOG, DEFAULT_COURSE_ID } from "./course/catalog";

const FIXED_DT = 1 / 120; // design 6.4: physics runs at a fixed timestep
const MAX_FRAME_DT = 0.1; // clamp huge dt after e.g. a backgrounded tab
const LOOKAHEAD_M = 25; // design 6.6: cockpitRig's corner look-ahead distance

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
  const lookahead = track.sampleAt(state.s + LOOKAHEAD_M).position;
  const right = normalize(cross(sample.tangent, sample.up));
  return {
    position: sample.position,
    forward: sample.tangent,
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

  let vehicle: VehicleState = { s: 0, speed: 0, lap: 0, lateralOffset: 0 };

  const cameraManager = new CameraManager([new ChaseRig(), new CockpitRig()]);
  cameraManager.init(camera, poseFor(track, vehicle));

  const engineAudio = new EngineAudio();
  const controls = createControls(
    document.body,
    cameraManager.list(),
    (id) => cameraManager.select(id),
    COURSE_CATALOG,
    COURSE_ID,
    selectCourse,
    (muted) => engineAudio.setMuted(muted),
  );
  const hud = new Hud(document.body, DEBUG, course.meta.name);

  const throttle = new KeyboardAxis(THROTTLE_KEYS);
  const brake = new KeyboardAxis(BRAKE_KEYS);
  // design 6.11: browsers keep a fresh AudioContext suspended until a user
  // gesture resumes it, so start the engine sound on the first keypress.
  window.addEventListener("keydown", () => engineAudio.start(), { once: true });

  let tPrev = performance.now();
  let accumulator = 0;
  let simTime = 0;
  let lastLapStartTime = 0;
  let lastLapTimeS: number | null = null;

  function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    const frameDt = Math.min(MAX_FRAME_DT, Math.max(0, (now - tPrev) / 1000));
    tPrev = now;
    accumulator += frameDt;

    const lapBefore = vehicle.lap;
    while (accumulator >= FIXED_DT) {
      const stepSample = track.sampleAt(vehicle.s);
      vehicle = stepVehicle(
        vehicle,
        throttle.read(),
        brake.read(),
        stepSample.grade,
        stepSample.curvature,
        FIXED_DT,
        DEFAULT_VEHICLE_PARAMS,
        track.length,
      );
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
      cornerLimited:
        vehicle.speed > cornerSpeedLimit(sample.curvature, DEFAULT_VEHICLE_PARAMS.maxLateralAccel),
    });
    hud.update(
      {
        speedKmh: vehicle.speed * 3.6,
        throttlePercent: throttle.read() * 100,
        brakePercent: brake.read() * 100,
        elevationM: pose.position.y,
        gradePercent: Math.sin(sample.grade) * 100,
        lap: vehicle.lap,
        lapDistanceM: vehicle.s,
        lastLapTimeS,
        cameraLabel: cameraManager.current.label,
      },
      DEBUG
        ? {
            s: sample.s,
            curvature: sample.curvature,
            widthLeft: sample.widthLeft,
            widthRight: sample.widthRight,
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
