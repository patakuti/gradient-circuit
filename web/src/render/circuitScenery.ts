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
import { bandWidth } from "../sim/surface";
import { buildStrip, createRng } from "./scenery";
import { createCurbTexture } from "./textures";

// Widths come from sim/surface.ts's SURFACE_LAYOUT (P13 follow-up) instead
// of being hardcoded here a second time, so the visible curb/grass and the
// physical grip/wall bands sim/vehicle.ts uses can never drift apart.
const CURB_WIDTH_M = bandWidth("circuit", "curb");
const CURB_HEIGHT_M = 0.05;
const CURB_TILE_M = 4; // stripe block length

const GRASS_WIDTH_M = bandWidth("circuit", "grass");

// Gap between the wall (render/barrier.ts, now drawn for every course kind
// as of P13.2) and the nearest tree, so trees don't crowd the barrier
// ribbon now that one actually renders past the grass here.
const TREE_BARRIER_CLEARANCE_M = 1.5;

const TREE_SPACING_M = 40;
const TREE_SKIP_PROBABILITY = 0.45;
const TREE_TRUNK_RADIUS_M = 0.25;
const TREE_TRUNK_MIN_HEIGHT_M = 2.5;
const TREE_TRUNK_MAX_HEIGHT_M = 4.5;
const TREE_FOLIAGE_MIN_RADIUS_M = 1.5;
const TREE_FOLIAGE_MAX_RADIUS_M = 3.0;

// Tree variety (design 6.12.1, P18): mix conifer (existing cone) and
// broadleaf (clustered low-poly spheres) shapes, with a small palette of
// green shades instead of one uniform color.
const CONIFER_PROBABILITY = 0.4;
const BROADLEAF_LOBE_COUNT_MIN = 2;
const BROADLEAF_LOBE_COUNT_MAX = 3;
const TRUNK_COLOR_PALETTE = [0x5a4633, 0x4f3d2c, 0x6b5440];
const CONIFER_FOLIAGE_COLOR_PALETTE = [0x2f5c33, 0x264a2a, 0x39683c];
const BROADLEAF_FOLIAGE_COLOR_PALETTE = [0x3f7a3f, 0x5a8f3a, 0x4a7a35, 0x6b9450];

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
  const trunkMaterials = TRUNK_COLOR_PALETTE.map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.9 }));
  const coniferMaterials = CONIFER_FOLIAGE_COLOR_PALETTE.map(
    (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.9 }),
  );
  const broadleafMaterials = BROADLEAF_FOLIAGE_COLOR_PALETTE.map(
    (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.95 }),
  );

  for (let s = 0; s < track.length; s += TREE_SPACING_M) {
    const sample = track.sampleAt(s);
    for (const side of ["left", "right"] as const) {
      if (rng() < TREE_SKIP_PROBABILITY) continue;

      const trunkHeight = TREE_TRUNK_MIN_HEIGHT_M + rng() * (TREE_TRUNK_MAX_HEIGHT_M - TREE_TRUNK_MIN_HEIGHT_M);
      const foliageRadius =
        TREE_FOLIAGE_MIN_RADIUS_M + rng() * (TREE_FOLIAGE_MAX_RADIUS_M - TREE_FOLIAGE_MIN_RADIUS_M);
      const base = edgeAt(sample, side, CURB_WIDTH_M + GRASS_WIDTH_M + TREE_BARRIER_CLEARANCE_M + foliageRadius);

      const tree = new THREE.Group();
      const trunkMaterial = trunkMaterials[Math.floor(rng() * trunkMaterials.length)];
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(TREE_TRUNK_RADIUS_M, TREE_TRUNK_RADIUS_M, trunkHeight),
        trunkMaterial,
      );
      trunk.position.y = trunkHeight / 2;
      tree.add(trunk);

      if (rng() < CONIFER_PROBABILITY) {
        // Conifer (existing shape): a single cone.
        const material = coniferMaterials[Math.floor(rng() * coniferMaterials.length)];
        const foliage = new THREE.Mesh(new THREE.ConeGeometry(foliageRadius, foliageRadius * 1.8), material);
        foliage.position.y = trunkHeight + (foliageRadius * 1.8) / 2;
        tree.add(foliage);
      } else {
        // Broadleaf (new): 2-3 overlapping low-poly spheres clumped around
        // the canopy center, so the silhouette has irregular lobes instead
        // of one perfect cone/sphere.
        const material = broadleafMaterials[Math.floor(rng() * broadleafMaterials.length)];
        const lobeCount =
          BROADLEAF_LOBE_COUNT_MIN + Math.floor(rng() * (BROADLEAF_LOBE_COUNT_MAX - BROADLEAF_LOBE_COUNT_MIN + 1));
        const canopyCenterY = trunkHeight + foliageRadius * 0.7;
        for (let i = 0; i < lobeCount; i++) {
          const lobeRadius = foliageRadius * (0.6 + rng() * 0.4);
          const angle = rng() * Math.PI * 2;
          const lobeOffset = foliageRadius * 0.35;
          const lobe = new THREE.Mesh(new THREE.IcosahedronGeometry(lobeRadius, 0), material);
          lobe.position.set(
            Math.cos(angle) * lobeOffset,
            canopyCenterY + (rng() - 0.5) * foliageRadius * 0.3,
            Math.sin(angle) * lobeOffset,
          );
          tree.add(lobe);
        }
      }

      tree.position.set(base.x, base.y, base.z);
      group.add(tree);
    }
  }
  return group;
}
