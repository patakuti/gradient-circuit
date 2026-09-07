/**
 * Scene environment: lighting, sky background, ground plane, fog.
 *
 * Design ref: 02_design.md section 6.7.
 */

import * as THREE from "three";
import type { Track } from "../sim/track";

const SKY_COLOR = 0x87ceeb;
const GROUND_COLOR = 0x2a2f26;
const GROUND_MARGIN_M = 20.0; // how far below the lowest track point the ground plane sits
const FOG_NEAR_FRACTION = 0.3;
const FOG_FAR_FRACTION = 1.0;

export interface EnvironmentHandles {
  lights: THREE.Group;
  ground: THREE.Mesh;
}

/** Track's horizontal extent and lowest point, used to size the ground plane. */
function trackBounds(track: Track): { minY: number; radius: number; centerX: number; centerZ: number } {
  let minY = Infinity;
  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < track.count; i++) {
    const p = track.sampleAt(i * track.ds).position;
    if (p.y < minY) minY = p.y;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const radius = Math.max(maxX - minX, maxZ - minZ) * 0.75 + 200;
  return { minY, radius, centerX, centerZ };
}

export function setupEnvironment(scene: THREE.Scene, track: Track): EnvironmentHandles {
  scene.background = new THREE.Color(SKY_COLOR);

  const bounds = trackBounds(track);
  const fogFar = bounds.radius * FOG_FAR_FRACTION;
  const fogNear = bounds.radius * FOG_NEAR_FRACTION;
  scene.fog = new THREE.Fog(SKY_COLOR, fogNear, fogFar);

  const lights = new THREE.Group();
  lights.name = "lights";
  const hemi = new THREE.HemisphereLight(0xffffff, 0x554433, 1.1);
  const sun = new THREE.DirectionalLight(0xfff4e5, 1.4);
  sun.position.set(bounds.centerX + 300, 500, bounds.centerZ + 200);
  sun.target.position.set(bounds.centerX, bounds.minY, bounds.centerZ);
  lights.add(hemi, sun, sun.target);
  scene.add(lights);

  const groundGeometry = new THREE.CircleGeometry(bounds.radius, 64);
  groundGeometry.rotateX(-Math.PI / 2);
  const groundMaterial = new THREE.MeshStandardMaterial({ color: GROUND_COLOR, roughness: 1.0 });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.position.set(bounds.centerX, bounds.minY - GROUND_MARGIN_M, bounds.centerZ);
  ground.name = "ground";
  scene.add(ground);

  return { lights, ground };
}
