/**
 * Application entry point: scene/camera/renderer setup and the composition
 * root. Per design 6.1, this file only wires modules together -- no
 * simulation or rendering logic of its own.
 *
 * P4 status: driving is live -- fixed-timestep sim/vehicle.ts integration,
 * slider/keyboard throttle, and a temporary chase camera + readout for
 * visual verification (design 03_plan.md P4). The real camera rigs (P5)
 * and polished HUD (P6) replace the temporary bits below.
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
import { vec3, add, scale, lerp, normalize, type Vec3 } from "./sim/vec";

const COURSE_URL = "/course/monaco.json";
const FIXED_DT = 1 / 120; // design 6.4: physics runs at a fixed timestep
const MAX_FRAME_DT = 0.1; // clamp huge dt after e.g. a backgrounded tab

// Temporary chase-camera numbers, matching design 6.6's planned chaseRig
// defaults so P5 can lift this straight into camera/chaseRig.ts.
const CHASE_BACK_M = 7.5;
const CHASE_UP_M = 2.8;
const CHASE_SMOOTH_K = 6.0;

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
 * Temporary throttle slider + speed/lap readout, styled just enough to be
 * usable for P4 verification. Replaced by the real ui/controls.ts and
 * ui/hud.ts in P6.
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

  document.body.appendChild(overlay);
  return { slider, readout };
}

function poseAt(track: Track, s: number): { position: Vec3; tangent: Vec3; up: Vec3 } {
  const sample = track.sampleAt(s);
  return { position: sample.position, tangent: sample.tangent, up: sample.up };
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

  // Camera starts directly behind the car at the start/finish line; the
  // fixed-timestep loop below then keeps it chasing smoothly.
  const startPose = poseAt(track, vehicle.s);
  const startCameraPos = add(
    startPose.position,
    add(scale(startPose.tangent, -CHASE_BACK_M), scale(startPose.up, CHASE_UP_M)),
  );
  camera.position.set(startCameraPos.x, startCameraPos.y, startCameraPos.z);
  camera.lookAt(startPose.position.x, startPose.position.y, startPose.position.z);

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

    const pose = poseAt(track, vehicle.s);
    const chaseTarget = add(pose.position, add(scale(pose.tangent, -CHASE_BACK_M), scale(pose.up, CHASE_UP_M)));
    const alpha = 1 - Math.exp(-CHASE_SMOOTH_K * frameDt);
    const smoothed = lerp(
      vec3(camera.position.x, camera.position.y, camera.position.z),
      chaseTarget,
      alpha,
    );
    camera.position.set(smoothed.x, smoothed.y, smoothed.z);
    const lookTarget = add(pose.position, scale(normalize(pose.tangent), 5));
    camera.lookAt(lookTarget.x, lookTarget.y, lookTarget.z);
    camera.up.set(pose.up.x, pose.up.y, pose.up.z);

    readout.textContent = `speed: ${(vehicle.speed * 3.6).toFixed(0)} km/h  lap: ${vehicle.lap}`;

    renderer.render(scene, camera);
  }
  animate();
}

main().catch((err) => {
  console.error("[main] failed to start:", err);
});
