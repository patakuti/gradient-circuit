/**
 * Application entry point: scene/camera/renderer setup and the composition
 * root. Per design 6.1, this file only wires modules together -- no
 * simulation or rendering logic of its own.
 *
 * P3 status: track mesh + environment are built and shown with a temporary
 * orbit camera for visual verification (design 03_plan.md P3). Driving
 * (P4) and the real camera rigs (P5) replace the orbit camera later.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { loadCourse } from "./course/loader";
import { Track } from "./sim/track";
import { buildTrackMesh } from "./render/trackMesh";
import { buildBarriers } from "./render/barrier";
import { setupEnvironment } from "./render/environment";

const COURSE_URL = "/course/monaco.json";

function createScene(): { scene: THREE.Scene; camera: THREE.PerspectiveCamera; renderer: THREE.WebGLRenderer } {
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.1,
    5000,
  );
  camera.position.set(0, 200, 400);

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

  // Temporary orbit camera for P3 visual verification (design 03_plan.md
  // P3). Start close to the start/finish line, low enough to read the
  // road surface and elevation change; OrbitControls lets you pull back
  // for the full-course overview.
  const start = track.sampleAt(0).position;
  const startTangent = track.sampleAt(0).tangent;
  camera.position.set(
    start.x - startTangent.x * 120 + 60,
    start.y + 60,
    start.z - startTangent.z * 120 + 60,
  );
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(start.x, start.y, start.z);
  controls.enableDamping = true;
  controls.minDistance = 10;
  controls.maxDistance = 3000;
  controls.update();

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();
}

main().catch((err) => {
  console.error("[main] failed to start:", err);
});
