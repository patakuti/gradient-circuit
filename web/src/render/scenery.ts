/**
 * Course-external scenery: dispatches to the course-specific builder
 * (design 6.12) and hosts the shared helpers both of them (and
 * render/barrier.ts) use to lay geometry along the track.
 */

import * as THREE from "three";
import type { Track, TrackSample } from "../sim/track";
import type { Vec3 } from "../sim/vec";
import type { CourseOption } from "../course/catalog";
import { buildCityScenery } from "./cityScenery";
import { buildCircuitScenery } from "./circuitScenery";

/**
 * Builds a ribbon/strip of triangles between two rails that both follow the
 * track: `bottomAt`/`topAt` compute each rail's absolute position from a
 * track sample (e.g. road edge vs. road edge + height for a wall, or two
 * lateral offsets at the same height for a flat strip like a curb or water
 * plane). Omitting `range` closes the strip into a full loop (e.g.
 * barrier.ts, circuitScenery.ts); passing `{ sStart, sEnd }` builds an open
 * segment covering only that part of the course (e.g. Monaco's tunnel/
 * harbor). `vTile` sets the texture-`v` repeat period along the strip's
 * length, matching render/textures.ts's `v = s / 10` convention.
 */
export function buildStrip(
  track: Track,
  bottomAt: (sample: TrackSample) => Vec3,
  topAt: (sample: TrackSample) => Vec3,
  range?: { sStart: number; sEnd: number },
  vTile = 10,
): THREE.BufferGeometry {
  const ds = track.ds;
  const closed = range === undefined;
  const sStart = range?.sStart ?? 0;
  const sEnd = range?.sEnd ?? track.length;
  const n = closed ? track.count : Math.max(2, Math.round((sEnd - sStart) / ds) + 1);

  const positions = new Float32Array(n * 2 * 3);
  const uvs = new Float32Array(n * 2 * 2);

  for (let i = 0; i < n; i++) {
    const s = closed ? i * ds : sStart + i * ds;
    const sample = track.sampleAt(s);
    const bottom = bottomAt(sample);
    const top = topAt(sample);

    const bi = i * 2;
    const ti = i * 2 + 1;
    positions[bi * 3] = bottom.x;
    positions[bi * 3 + 1] = bottom.y;
    positions[bi * 3 + 2] = bottom.z;
    positions[ti * 3] = top.x;
    positions[ti * 3 + 1] = top.y;
    positions[ti * 3 + 2] = top.z;

    const v = s / vTile;
    uvs[bi * 2] = 0;
    uvs[bi * 2 + 1] = v;
    uvs[ti * 2] = 1;
    uvs[ti * 2 + 1] = v;
  }

  const indices: number[] = [];
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % n;
    const b0 = i * 2, t0 = i * 2 + 1, b1 = j * 2, t1 = j * 2 + 1;
    indices.push(b0, t0, b1);
    indices.push(t0, t1, b1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Deterministic PRNG (mulberry32) so scenery placement (building heights,
 * tree spacing, ...) looks the same across reloads instead of reshuffling.
 */
export function createRng(seed: number): () => number {
  let a = seed;
  return function (): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildScenery(track: Track, course: CourseOption): THREE.Group {
  const group = new THREE.Group();
  group.name = "scenery";
  if (course.kind === "street") {
    group.add(buildCityScenery(track, course.features ?? []));
  } else {
    group.add(buildCircuitScenery(track));
  }
  return group;
}
