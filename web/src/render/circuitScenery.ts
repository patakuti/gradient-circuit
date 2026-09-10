/**
 * Suzuka-style permanent-circuit scenery: curbs, a grass verge, and sparse
 * trees outside it.
 *
 * Design ref: 02_design.md section 6.12.
 */

import * as THREE from "three";
import { add, scale, vec3 } from "../sim/vec";
import type { Vec3 } from "../sim/vec";
import type { Track, TrackSample } from "../sim/track";
import { buildStrip, createRng } from "./scenery";
import { createCurbTexture } from "./textures";

const CURB_WIDTH_M = 0.6;
const CURB_HEIGHT_M = 0.05;
const CURB_TILE_M = 4; // stripe block length

const GRASS_WIDTH_M = 6;

const TREE_SPACING_M = 40;
const TREE_SKIP_PROBABILITY = 0.45;
const TREE_TRUNK_RADIUS_M = 0.25;
const TREE_TRUNK_MIN_HEIGHT_M = 2.5;
const TREE_TRUNK_MAX_HEIGHT_M = 4.5;
const TREE_FOLIAGE_MIN_RADIUS_M = 1.5;
const TREE_FOLIAGE_MAX_RADIUS_M = 3.0;

function edgeAt(sample: TrackSample, side: "left" | "right", offset: number): Vec3 {
  const halfWidth = side === "left" ? sample.widthLeft : sample.widthRight;
  const sign = side === "left" ? 1 : -1;
  return add(sample.position, scale(sample.normal, (halfWidth + offset) * sign));
}

export function buildCircuitScenery(track: Track): THREE.Group {
  const group = new THREE.Group();
  group.name = "circuitScenery";
  group.add(buildCurbs(track));
  group.add(buildGrassVerge(track));
  group.add(buildTrees(track));
  return group;
}

function buildCurbs(track: Track): THREE.Group {
  const group = new THREE.Group();
  group.name = "curbs";
  const texture = createCurbTexture();
  const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.7, side: THREE.DoubleSide });

  for (const side of ["left", "right"] as const) {
    const inner = (sample: TrackSample): Vec3 => add(edgeAt(sample, side, 0), vec3(0, CURB_HEIGHT_M, 0));
    const outer = (sample: TrackSample): Vec3 => add(edgeAt(sample, side, CURB_WIDTH_M), vec3(0, CURB_HEIGHT_M, 0));
    const geometry = buildStrip(track, inner, outer, undefined, CURB_TILE_M);
    group.add(new THREE.Mesh(geometry, material));
  }
  return group;
}

function buildGrassVerge(track: Track): THREE.Group {
  const group = new THREE.Group();
  group.name = "grassVerge";
  const material = new THREE.MeshStandardMaterial({ color: 0x3a5a2e, roughness: 1.0, side: THREE.DoubleSide });

  for (const side of ["left", "right"] as const) {
    const inner = (sample: TrackSample): Vec3 => edgeAt(sample, side, CURB_WIDTH_M);
    const outer = (sample: TrackSample): Vec3 => edgeAt(sample, side, CURB_WIDTH_M + GRASS_WIDTH_M);
    const geometry = buildStrip(track, inner, outer, undefined);
    group.add(new THREE.Mesh(geometry, material));
  }
  return group;
}

function buildTrees(track: Track): THREE.Group {
  const group = new THREE.Group();
  group.name = "trees";
  const rng = createRng(3);
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x5a4633, roughness: 0.9 });
  const foliageMaterial = new THREE.MeshStandardMaterial({ color: 0x2f5c33, roughness: 0.9 });

  for (let s = 0; s < track.length; s += TREE_SPACING_M) {
    const sample = track.sampleAt(s);
    for (const side of ["left", "right"] as const) {
      if (rng() < TREE_SKIP_PROBABILITY) continue;

      const trunkHeight = TREE_TRUNK_MIN_HEIGHT_M + rng() * (TREE_TRUNK_MAX_HEIGHT_M - TREE_TRUNK_MIN_HEIGHT_M);
      const foliageRadius =
        TREE_FOLIAGE_MIN_RADIUS_M + rng() * (TREE_FOLIAGE_MAX_RADIUS_M - TREE_FOLIAGE_MIN_RADIUS_M);
      const base = edgeAt(sample, side, CURB_WIDTH_M + GRASS_WIDTH_M + foliageRadius);

      const tree = new THREE.Group();
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(TREE_TRUNK_RADIUS_M, TREE_TRUNK_RADIUS_M, trunkHeight),
        trunkMaterial,
      );
      trunk.position.y = trunkHeight / 2;
      const foliage = new THREE.Mesh(
        new THREE.ConeGeometry(foliageRadius, foliageRadius * 1.8),
        foliageMaterial,
      );
      foliage.position.y = trunkHeight + (foliageRadius * 1.8) / 2;
      tree.add(trunk, foliage);
      tree.position.set(base.x, base.y, base.z);
      group.add(tree);
    }
  }
  return group;
}
