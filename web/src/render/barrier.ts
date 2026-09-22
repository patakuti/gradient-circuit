/**
 * Trackside barrier: a simple vertical ribbon along each edge of the road.
 *
 * Design ref: 02_design.md section 6.7/6.13.3 -- not a reconstruction of
 * Monaco's real barriers/buildings (out of scope per 01_requirements.md
 * 2.2), just a visual reference for speed, elevation change, and where the
 * car actually stops. Drawn at exactly sim/surface.ts's `barrierOffsetAt()`
 * (P13 follow-up) so the visible wall and the physical one can never
 * disagree (acceptance criterion #19).
 */

import * as THREE from "three";
import { add, scale } from "../sim/vec";
import type { CourseFeature, CourseKind } from "../course/catalog";
import { barrierOffsetAt } from "../sim/surface";
import type { Track, TrackSample } from "../sim/track";
import { buildStrip } from "./scenery";

const BARRIER_HEIGHT_M = 1.0;

function edgeAt(
  courseKind: CourseKind,
  sample: TrackSample,
  side: "left" | "right",
  curbFeatures: CourseFeature[],
): { x: number; y: number; z: number } {
  const sign = side === "left" ? 1 : -1;
  return add(sample.position, scale(sample.normal, barrierOffsetAt(courseKind, sample, side, curbFeatures) * sign));
}

/**
 * `features` (design 6.13.5, P27, default []): the course's `curb`-type
 * CourseFeatures, so the barrier ribbon steps outward by the curb's width
 * within a curb zone -- kept in sync with barrierOffsetAt() so the visible
 * wall and the physical one never disagree (design 6.13.3).
 */
export function buildBarriers(track: Track, courseKind: CourseKind, features: CourseFeature[] = []): THREE.Group {
  const curbFeatures = features.filter((f) => f.type === "curb");
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
      (sample) => edgeAt(courseKind, sample, side, curbFeatures),
      (sample) => add(edgeAt(courseKind, sample, side, curbFeatures), { x: 0, y: BARRIER_HEIGHT_M, z: 0 }),
    );
    group.add(new THREE.Mesh(geometry, material));
  }
  return group;
}
