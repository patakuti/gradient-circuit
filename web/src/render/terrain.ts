/**
 * Coarse terrain: a 2D heightfield covering the whole course, so that two
 * points close in world space but far apart along the track (Monaco's
 * hairpins fold back on themselves; the harbor straight faces the hillside
 * across the water) always have solid ground between them.
 *
 * Design ref: 02_design.md section 6.7.2. render/embankment.ts's cliff and
 * cityScenery.ts's ground shelf are both s-parameterized ribbons -- they
 * only ever exist beside *their own* sample, so from a different, nearby
 * (in world space) part of the loop, whatever they'd be backing (a
 * building, the road, the barrier) still has no ground under it and its
 * underside shows through (design 6.7.1's P28 follow-ups). A heightfield
 * keyed on (x, z) instead of s has no such blind spot.
 */

import * as THREE from "three";
import { add, scale } from "../sim/vec";
import type { Track } from "../sim/track";
import type { CourseFeature } from "../course/catalog";
import { trackBounds } from "./environment";

// A separate color from environment.ts's GROUND_COLOR (not shared): that
// color was chosen for a flat, always-distant background disc, where its
// dark olive tone reads as neutral. This heightfield is far more
// prominent -- close, steep hillsides right next to the harbor road, not
// just a faint backdrop -- and the same color there reads as a bright
// green "landslide" mass (user: "緑の土砂崩れ", 03_plan.md P29 seventh
// follow-up), especially under the hemisphere light's sky-colored fill on
// steeply-angled facets. A warmer, grayer stone tone reads as hillside
// rock instead.
//
// Exported so render/embankment.ts's terrain-following "elsewhere"
// segments (P30 sixth/seventh follow-up) can match this exactly -- using
// a different color there (as the embankment's own course-specific wall
// color did originally) drew a visible seam right where the two meshes
// meet, reading as a separate wall standing in front of the terrain
// rather than the terrain itself simply starting at the fence (P30
// seventh follow-up, user report).
export const TERRAIN_COLOR = 0x6b6355;

const TERRAIN_GRID_CELL_M = 10;
// Measured (03_plan.md P29 third/fourth follow-up): a larger radius lets a
// sample far along s but close in world space and much *higher* (Monaco's
// Casino hillside passes within ~56m of the harbor straight, 32m above it;
// the hairpin's own two strands are ~15-65m apart, 9m+ apart in elevation)
// dominate the max-of-decayed-bumps below and erupt the terrain up through
// the *lower* road there -- up to +18.8m measured at radius=200. A hard
// per-cell clamp to the world-nearest sample's own height was tried and
// reverted: "nearest sample" flips discontinuously right at the boundary
// between two strands' zones of influence, which reintroduced a *sharp
// edge* in the heightfield there (screenshot: MonacoChase9.png, a
// roof-like overhang with a visible sky notch cut into it, right at the
// hairpin's tightest point). Shrinking the radius instead keeps every
// contribution continuous (no clamp needed) while still comfortably
// bridging the gaps this feature exists for -- swept empirically (below)
// for the smallest radius with zero poke-through on both courses, then use
// that same radius everywhere for one consistent falloff shape.
const TERRAIN_INFLUENCE_RADIUS_M = 70;
const TERRAIN_SAMPLE_STEP_M = 10; // how finely the track is thinned before scanning distances
// Keeps the terrain from ever reaching the exact height of the road/ribbons
// even directly under a sample, so it can't poke through and z-fight with
// them -- it's meant to sit just below, as backing mass. Larger than the
// minimum needed at a single sample (a meter or so) because the
// max-of-samples height at a given (x, z) can be dominated by a
// *different*, higher sample nearby in world space but at a different,
// higher point along the road's own grade -- e.g. under the tunnel, where
// the terrain is supposed to rise to model the hill it bores through, or
// Suzuka's figure-8 crossover, where two different s ranges pass within a
// couple meters of each other in world space but ~5m apart in elevation
// (one level is a bridge over the other). Measured (03_plan.md P29 third
// follow-up), with the nearest-sample clamp below also in place: 5.0m still
// left a 1.25m poke-through at the Suzuka crossover (s~2516); 6.5m clears
// every *sample centerline* on both Monaco and Suzuka with margin to spare.
//
// That centerline-only check missed a real intrusion at the *pavement
// edge*: near the Grand Hotel Hairpin exit (s~1290), a sample from the
// hairpin's other, higher strand dominates the max-of-samples height right
// at this strand's own road edge, and at 6.5m margin the terrain actually
// pokes 0.99m *above* the road surface there (03_plan.md P29 eighth
// follow-up -- user report: "土砂崩れがコースにはみ出ている"). Measured by
// scanning terrain height across each sample's own paved width (not just
// its centerline) at several margins: 8m still leaves a thin margin
// (-0.38m); 10m clears the worst point on either course by ~2.2m.
const TERRAIN_SAFETY_MARGIN_M = 10;

// Harbor water geometry, mirrored from cityScenery.ts's buildHarbor() (not
// imported from there -- that module isn't exported for reuse, and this is
// only the handful of numbers needed to keep terrain out of the water, not
// the water mesh itself).
const HARBOR_EDGE_MARGIN_M = 1.5;
const HARBOR_WATER_WIDTH_M = 45;

// Smoothstep-shaped falloff (zero slope at both t=0 and t=1), not the
// simpler (1-t)^2: that has a non-zero slope at t=0, so each sample point
// bumps the heightfield up into a sharp cone rather than a smooth dome.
// Since MAX doesn't blend between overlapping cones, the ridge line where
// dominance switches between two nearby samples reads as a jagged
// "shark-fin" silhouette against the sky (found from the user's actual
// screenshot after the first cut of this feature -- 03_plan.md P29 second
// follow-up). A dome that's flat right at its own peak removes that.
function falloff(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - clamped * clamped * (3 - 2 * clamped);
}

/**
 * The harbor's water sits at ~road height (design 6.12's buildHarbor), well
 * within TERRAIN_INFLUENCE_RADIUS_M of the harbor-side samples that feed
 * the main heightfield above -- measured (03_plan.md P29) to poke through
 * the water surface once the radius is large enough to usefully bridge the
 * hairpin/harbor gaps this feature exists for. These points cap the
 * heightfield back down under the water's own footprint specifically,
 * independent of the radius chosen for everywhere else.
 */
function waterCeilingPoints(
  track: Track,
  features: CourseFeature[],
): { x: number; z: number; y: number }[] {
  const harbor = features.find((f) => f.type === "harbor");
  if (!harbor) return [];
  const side = harbor.side ?? "right";
  const sign = side === "left" ? 1 : -1;

  const result: { x: number; z: number; y: number }[] = [];
  for (let s = harbor.sStart; s < harbor.sEnd; s += TERRAIN_SAMPLE_STEP_M) {
    const sample = track.sampleAt(s);
    const half = side === "left" ? sample.widthLeft : sample.widthRight;
    const centerOffset = (half + HARBOR_EDGE_MARGIN_M + HARBOR_WATER_WIDTH_M / 2) * sign;
    const center = add(sample.position, scale(sample.normal, centerOffset));
    result.push({ x: center.x, z: center.z, y: sample.position.y - 0.1 - TERRAIN_SAFETY_MARGIN_M });
  }
  return result;
}

/**
 * A queryable version of the same heightfield `buildTerrain()` renders as a
 * grid mesh, for callers that need the terrain's height at an arbitrary
 * (x, z) rather than a mesh to draw (design 6.7.1, P30 fourth follow-up --
 * render/embankment.ts's "elsewhere" default floor, replacing a flat
 * `groundY` that left a gap between the barrier and this terrain's own
 * safety-margin-lowered surface directly beneath it).
 */
export interface TerrainSampler {
  heightAt(x: number, z: number): number;
}

/**
 * `fenceAnchors` (design 6.7.1/6.7.2, P30 eighth follow-up): extra points
 * fed into the same max-of-decayed-bumps heightfield as the track's own
 * centerline samples below, but at their *full* given height -- not
 * lowered by TERRAIN_SAFETY_MARGIN_M like every other point here. Passing
 * a circuit course's own barrier-line points (render/embankment.ts's
 * `computeCircuitFenceAnchors()`) makes the heightfield rise to meet the
 * barrier directly wherever they're supplied, so the terrain itself reads
 * as starting right at the fence with no gap and no separate ribbon mesh
 * needed to fake it -- direct user request ("フェンスの下から直接地形
 * メッシュが始めるようにしてほしい"): a same-colored ribbon standing in
 * front of the terrain (P30 sixth/seventh follow-up's approach) still drew
 * as a second surface, however well the color matched. Left out of the
 * zones embankment.ts detects as a crossover (Suzuka's figure-8): those
 * already get a flat "bridge deck" ribbon and must keep the terrain at its
 * normal, lower height there so the deck reads as passing over it.
 */
export function createTerrainSampler(
  track: Track,
  groundY: number,
  features: CourseFeature[],
  fenceAnchors: { x: number; y: number; z: number }[] = [],
): TerrainSampler {
  const points: { x: number; z: number; y: number }[] = [];
  for (let s = 0; s < track.length; s += TERRAIN_SAMPLE_STEP_M) {
    const p = track.sampleAt(s).position;
    points.push({ x: p.x, z: p.z, y: p.y - TERRAIN_SAFETY_MARGIN_M });
  }
  for (const anchor of fenceAnchors) points.push({ x: anchor.x, z: anchor.z, y: anchor.y });
  const waterCeilings = waterCeilingPoints(track, features);
  const waterHalfWidth = HARBOR_WATER_WIDTH_M / 2 + TERRAIN_GRID_CELL_M; // +1 cell of slack so the clamp doesn't leave a hard edge right at the shoreline
  const radiusSq = TERRAIN_INFLUENCE_RADIUS_M * TERRAIN_INFLUENCE_RADIUS_M;

  function heightAt(x: number, z: number): number {
    let height = groundY;
    for (const point of points) {
      const dx = x - point.x;
      const dz = z - point.z;
      const distSq = dx * dx + dz * dz;
      if (distSq >= radiusSq) continue;
      const dist = Math.sqrt(distSq);
      const bumped = groundY + (point.y - groundY) * falloff(dist / TERRAIN_INFLUENCE_RADIUS_M);
      if (bumped > height) height = bumped;
    }
    for (const wp of waterCeilings) {
      const dx = x - wp.x;
      const dz = z - wp.z;
      if (dx * dx + dz * dz > waterHalfWidth * waterHalfWidth) continue;
      if (wp.y < height) height = wp.y;
    }
    return height;
  }

  return { heightAt };
}

export function buildTerrain(
  track: Track,
  groundY: number,
  features: CourseFeature[],
  fenceAnchors: { x: number; y: number; z: number }[] = [],
): THREE.Mesh {
  const bounds = trackBounds(track);
  const sampler = createTerrainSampler(track, groundY, features, fenceAnchors);

  const minX = bounds.minX - TERRAIN_INFLUENCE_RADIUS_M;
  const maxX = bounds.maxX + TERRAIN_INFLUENCE_RADIUS_M;
  const minZ = bounds.minZ - TERRAIN_INFLUENCE_RADIUS_M;
  const maxZ = bounds.maxZ + TERRAIN_INFLUENCE_RADIUS_M;
  const cols = Math.max(2, Math.ceil((maxX - minX) / TERRAIN_GRID_CELL_M));
  const rows = Math.max(2, Math.ceil((maxZ - minZ) / TERRAIN_GRID_CELL_M));

  const positions = new Float32Array((cols + 1) * (rows + 1) * 3);

  for (let row = 0; row <= rows; row++) {
    const z = minZ + (row / rows) * (maxZ - minZ);
    for (let col = 0; col <= cols; col++) {
      const x = minX + (col / cols) * (maxX - minX);
      const height = sampler.heightAt(x, z);

      const i = (row * (cols + 1) + col) * 3;
      positions[i] = x;
      positions[i + 1] = height;
      positions[i + 2] = z;
    }
  }

  const indices: number[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const a = row * (cols + 1) + col;
      const b = a + 1;
      const c = a + (cols + 1);
      const d = c + 1;
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({ color: TERRAIN_COLOR, roughness: 1.0 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "terrain";
  return mesh;
}
