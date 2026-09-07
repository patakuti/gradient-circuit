/**
 * Application entry point: scene/camera/renderer setup and the composition
 * root. Per design 6.1, this file only wires modules together -- no
 * simulation or rendering logic of its own.
 *
 * P5 status: two camera rigs (chase, cockpit) are wired through
 * CameraManager, switchable with the `C` key (design 03_plan.md P5). The
 * polished HUD (P6) still needs to add a camera-select control alongside it.
 */

import * as THREE from "three";
import { loadCourse } from "./course/loader";
import { Track } from "./sim/track";
import { buildTrackMesh } from "./render/trackMesh";
import { buildBarriers } from "./render/barrier";
import { setupEnvironment } from "./render/environment";
import { stepVehicle, type VehicleState } from "./sim/vehicle";
import { DEFAULT_VEHICLE_PARAMS } from "./sim/vehicleParams";
import { SliderThrottle, KeyboardThrottle, CombinedThrottle } from "./sim/input";
import { normalize, cross } from "./sim/vec";
import { CameraManager } from "./camera/manager";
import { ChaseRig } from "./camera/chaseRig";
import { CockpitRig } from "./camera/cockpitRig";
import type { VehiclePose } from "./camera/types";

const COURSE_URL = "/course/monaco.json";
const FIXED_DT = 1 / 120; // design 6.4: physics runs at a fixed timestep
const MAX_FRAME_DT = 0.1; // clamp huge dt after e.g. a backgrounded tab
const LOOKAHEAD_M = 25; // design 6.6: cockpitRig's corner look-ahead distance

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

/**
 * Temporary throttle slider + speed/lap/camera readout, styled just enough
 * to be usable for P4/P5 verification. Replaced by the real ui/controls.ts
 * and ui/hud.ts in P6.
 */
function createTemporaryOverlay(): { slider: HTMLInputElement; readout: HTMLDivElement } {
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;left:12px;bottom:12px;padding:8px 12px;background:rgba(0,0,0,0.55);" +
    "color:#fff;font:13px monospace;border-radius:6px;display:flex;flex-direction:column;gap:6px;z-index:10;";

  const readout = document.createElement("div");
  readout.textContent = "speed: 0 km/h  lap: 0";
  overlay.appendChild(readout);

  const sliderRow = document.createElement("label");
  sliderRow.style.cssText = "display:flex;align-items:center;gap:8px;";
  sliderRow.textContent = "throttle";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  slider.value = "0";
  sliderRow.appendChild(slider);
  overlay.appendChild(sliderRow);

  const hint = document.createElement("div");
  hint.style.opacity = "0.7";
  hint.textContent = "[C] switch camera";
  overlay.appendChild(hint);

  document.body.appendChild(overlay);
  return { slider, readout };
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
  scene.add(buildBarriers(track));

  const { slider, readout } = createTemporaryOverlay();
  const sliderThrottle = new SliderThrottle(slider);
  const keyboardThrottle = new KeyboardThrottle(sliderThrottle);
  const throttle = new CombinedThrottle([sliderThrottle, keyboardThrottle]);

  let vehicle: VehicleState = { s: 0, speed: 0, lap: 0, lateralOffset: 0 };

  const cameraManager = new CameraManager([new ChaseRig(), new CockpitRig()]);
  cameraManager.init(camera, poseFor(track, vehicle));

  let tPrev = performance.now();
  let accumulator = 0;

  function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    const frameDt = Math.min(MAX_FRAME_DT, Math.max(0, (now - tPrev) / 1000));
    tPrev = now;
    accumulator += frameDt;

    const lapBefore = vehicle.lap;
    while (accumulator >= FIXED_DT) {
      const grade = track.sampleAt(vehicle.s).grade;
      vehicle = stepVehicle(vehicle, throttle.read(), grade, FIXED_DT, DEFAULT_VEHICLE_PARAMS, track.length);
      accumulator -= FIXED_DT;
    }
    if (vehicle.lap !== lapBefore) {
      console.log(`[vehicle] lap ${vehicle.lap} complete`);
    }

    const pose = poseFor(track, vehicle);
    cameraManager.update(camera, pose, frameDt);

    readout.textContent =
      `speed: ${(vehicle.speed * 3.6).toFixed(0)} km/h  lap: ${vehicle.lap}  ` +
      `camera: ${cameraManager.current.label}`;

    renderer.render(scene, camera);
  }
  animate();
}

main().catch((err) => {
  console.error("[main] failed to start:", err);
});
