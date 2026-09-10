/**
 * Trackside barrier: a simple vertical ribbon along each edge of the road.
 *
 * Design ref: 02_design.md section 6.7 -- not a reconstruction of Monaco's
 * real barriers/buildings (out of scope per 01_requirements.md 2.2), just a
 * visual reference for speed and elevation change. Enabled by default.
 */

import * as THREE from "three";
import { add, scale } from "../sim/vec";
import type { Track, TrackSample } from "../sim/track";
import { buildStrip } from "./scenery";

const BARRIER_HEIGHT_M = 1.0;
const EDGE_OFFSET_M = 0.3; // small outward offset from the road edge to avoid z-fighting

function edgeAt(sample: TrackSample, side: "left" | "right"): { x: number; y: number; z: number } {
  const halfWidth = side === "left" ? sample.widthLeft : sample.widthRight;
  const sign = side === "left" ? 1 : -1;
  const offset = halfWidth + EDGE_OFFSET_M;
  return add(sample.position, scale(sample.normal, offset * sign));
}

export function buildBarriers(track: Track): THREE.Group {
  const material = new THREE.MeshStandardMaterial({
    color: 0xd6d6d6,
    roughness: 0.6,
    side: THREE.DoubleSide,
  });

  const group = new THREE.Group();
  group.name = "barriers";
  for (const side of ["left", "right"] as const) {
    const geometry = buildStrip(
      track,
      (sample) => edgeAt(sample, side),
      (sample) => add(edgeAt(sample, side), { x: 0, y: BARRIER_HEIGHT_M, z: 0 }),
    );
    group.add(new THREE.Mesh(geometry, material));
  }
  return group;
}
