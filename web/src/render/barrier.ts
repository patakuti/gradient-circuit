/**
 * Trackside barrier: a simple vertical ribbon along each edge of the road.
 *
 * Design ref: 02_design.md section 6.7 -- not a reconstruction of Monaco's
 * real barriers/buildings (out of scope per 01_requirements.md 2.2), just a
 * visual reference for speed and elevation change. Enabled by default.
 */

import * as THREE from "three";
import type { Track } from "../sim/track";

const BARRIER_HEIGHT_M = 1.0;
const EDGE_OFFSET_M = 0.3; // small outward offset from the road edge to avoid z-fighting

function buildEdgeRibbon(track: Track, side: "left" | "right"): THREE.BufferGeometry {
  const n = track.count;
  const positions = new Float32Array(n * 2 * 3);

  for (let i = 0; i < n; i++) {
    const s = i * track.ds;
    const sample = track.sampleAt(s);
    const halfWidth = side === "left" ? sample.widthLeft : sample.widthRight;
    const sign = side === "left" ? 1 : -1;
    const offset = halfWidth + EDGE_OFFSET_M;

    const baseX = sample.position.x + sample.normal.x * offset * sign;
    const baseY = sample.position.y + sample.normal.y * offset * sign;
    const baseZ = sample.position.z + sample.normal.z * offset * sign;

    const bi = i * 2; // bottom vertex
    const ti = i * 2 + 1; // top vertex

    positions[bi * 3] = baseX;
    positions[bi * 3 + 1] = baseY;
    positions[bi * 3 + 2] = baseZ;
    positions[ti * 3] = baseX;
    positions[ti * 3 + 1] = baseY + BARRIER_HEIGHT_M;
    positions[ti * 3 + 2] = baseZ;
  }

  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const b0 = i * 2, t0 = i * 2 + 1;
    const b1 = j * 2, t1 = j * 2 + 1;
    if (side === "left") {
      indices.push(b0, t0, b1);
      indices.push(t0, t1, b1);
    } else {
      indices.push(b0, b1, t0);
      indices.push(t0, b1, t1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export function buildBarriers(track: Track): THREE.Group {
  const material = new THREE.MeshStandardMaterial({
    color: 0xd6d6d6,
    roughness: 0.6,
    side: THREE.DoubleSide,
  });

  const group = new THREE.Group();
  group.name = "barriers";
  group.add(new THREE.Mesh(buildEdgeRibbon(track, "left"), material));
  group.add(new THREE.Mesh(buildEdgeRibbon(track, "right"), material));
  return group;
}
