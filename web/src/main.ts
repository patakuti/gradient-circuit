/**
 * Application entry point: scene/camera/renderer setup and the composition
 * root. Per design 6.1, this file only wires modules together -- no
 * simulation or rendering logic of its own.
 */

import * as THREE from "three";
import { loadCourse } from "./course/loader";

const COURSE_URL = "/course/monaco.json";

function createScene(): { scene: THREE.Scene; camera: THREE.PerspectiveCamera; renderer: THREE.WebGLRenderer } {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);

  const camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.1,
    5000,
  );
  camera.position.set(0, 200, 400);
  camera.lookAt(0, 0, 0);

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

  // Placeholder light so the (currently empty) scene isn't pitch black once
  // geometry is added in P3.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.0));

  try {
    const course = await loadCourse(COURSE_URL);
    console.log(
      `[course] loaded "${course.meta.name}" (${course.meta.event} ${course.meta.year} ` +
        `${course.meta.session}): ${course.count} samples, length=${course.length.toFixed(1)}m, ` +
        `closed=${course.closed}, bank_source=${course.meta.bank_source}`,
    );
  } catch (err) {
    console.error("[course] failed to load:", err);
  }

  function animate() {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
  }
  animate();
}

main();
