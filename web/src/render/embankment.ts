/**
 * Ground-connecting "embankment" ribbon: closes the gap between the
 * trackside edge (barrier.ts's line) and the flat ground plane
 * (environment.ts), which otherwise sit at very different heights on a
 * course with real elevation change (Monaco) -- see 02_design.md 6.7.1 for
 * the symptoms this fixes (floating buildings, see-through ground beside
 * curbs, buildings viewed from underneath on a downhill) and the root
 * cause.
 *
 * Design ref: 02_design.md section 6.7.1.
 */

import * as THREE from "three";
import { add, scale } from "../sim/vec";
import type { CourseFeature, CourseKind } from "../course/catalog";
import { barrierOffsetAt } from "../sim/surface";
import type { Track, TrackSample } from "../sim/track";
import { buildStrip } from "./scenery";
import { GROUND_COLOR } from "./environment";
import { EMBANKMENT_WALL_COLOR_STREET, groundShelfOffset } from "./cityScenery";
import { createTerrainSampler, TERRAIN_COLOR } from "./terrain";

/**
 * `[sStart, sEnd)`, split into 1-2 non-wrapping sub-ranges (`sStart > sEnd`
 * wraps past the loop's s=0 seam, same convention as `noBuilding`/
 * `embankment` CourseFeatures -- course/catalog.ts's doc comment).
 * `buildStrip`'s own `range` param has no wrap support, hence the split.
 */
function splitWrappingRange(sStart: number, sEnd: number, length: number): Array<{ sStart: number; sEnd: number }> {
  if (sStart <= sEnd) return [{ sStart, sEnd }];
  return [
    { sStart, sEnd: length },
    { sStart: 0, sEnd },
  ];
}

/**
 * The full loop `[0, length)` minus the given (possibly wrapping) ranges,
 * as non-wrapping remaining ranges -- design 6.7.1, P30 seventh follow-up:
 * used to build the "elsewhere" (terrain-following) segments of the
 * embankment separately from the fixed-floor zone segments, so the two
 * can use different materials (see buildStreetEmbankment()/
 * buildCircuitEmbankment() below) instead of one ribbon whose color would
 * otherwise have to be uniform end to end.
 */
function complementRanges(
  ranges: Array<{ sStart: number; sEnd: number }>,
  length: number,
): Array<{ sStart: number; sEnd: number }> {
  const intervals: Array<[number, number]> = [];
  for (const r of ranges) {
    for (const split of splitWrappingRange(r.sStart, r.sEnd, length)) intervals.push([split.sStart, split.sEnd]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of intervals) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const remaining: Array<{ sStart: number; sEnd: number }> = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) remaining.push({ sStart: cursor, sEnd: s });
    cursor = Math.max(cursor, e);
  }
  if (cursor < length) remaining.push({ sStart: cursor, sEnd: length });
  return remaining;
}

/**
 * The embankment's own horizontal position: the barrier's (x, z) line for
 * a circuit course (Suzuka), but the *street ground shelf's own outer
 * edge* for a street course (Monaco) -- design 6.7.1, P30 fifth follow-up,
 * user request. Previously this used the barrier line for both, but on
 * Monaco the visible ground (and the buildings on it, render/
 * cityScenery.ts's `buildStreetGround()`/`buildBuildings()`) continues on
 * past the barrier for up to `GROUND_SHELF_REACH_M` further -- starting
 * the terrain-connecting cliff at the barrier left that outer strip (and
 * whatever stands on it) with nothing connecting it down to the terrain,
 * i.e. still "floating" by the same definition P28 fixed for the barrier
 * itself. Reuses `groundShelfOffset()` (cityScenery.ts) rather than a
 * second copy so the two can't drift apart.
 */
function edgeAt(
  courseKind: CourseKind,
  track: Track,
  sample: TrackSample,
  side: "left" | "right",
  features: CourseFeature[],
): { x: number; y: number; z: number } {
  const sign = side === "left" ? 1 : -1;
  const offset =
    courseKind === "street"
      ? groundShelfOffset(track, sample, side, features)
      : barrierOffsetAt(courseKind, sample, side, features.filter((f) => f.type === "curb"));
  return add(sample.position, scale(sample.normal, offset * sign));
}

// Reference points used to find a *different*, nearby-in-world-space (but
// far-in-s) part of the same course passing underneath this embankment --
// see findCrossoverZones() below. Sampled coarsely (not every track.ds=1m
// sample) since this is only used for a distance search, mirrors
// terrain.ts's TERRAIN_SAMPLE_STEP_M.
const CROSSOVER_SAMPLE_STEP_M = 10;
// A candidate must be at least this far away along s to count as a
// genuinely different part of the course rather than just "a few meters
// further down this same downhill stretch" -- e.g. Suzuka's steepest
// grades drop several meters over 150m, and a same-strand candidate that
// close must never shorten the cliff (it isn't backed by anything real).
// Measured (03_plan.md P28 fifth follow-up): 150m cleanly isolates
// Suzuka's one real figure-8 crossover (s~4860-4900) with no other course
// location on either Monaco or Suzuka falsely triggering.
const CROSSOVER_EXCLUDE_S_M = 150;
// How close in world space a lower, far-in-s point must be to count this
// sample as genuinely "under/over" that other part of the course, not just
// generally nearby on the same hillside. Tight on purpose (see
// findCrossoverZones()) -- measured (03_plan.md P28 sixth follow-up): a
// looser radius here (previously 60m, used directly as the falloff
// distance) also caught points 30-40m away with almost no falloff left,
// producing a smoothly domed, arch-shaped cliff bottom instead of the
// flat, slab-like underside a real bridge/overpass has (user: "アーチ状に
// なっているけれど、実際は板のように平ら"). A tight capture radius picks
// out only the true "under this bridge" stretch; how far that stretch
// gets a flat floor, and how the ends taper, is controlled separately by
// CROSSOVER_ZONE_PAD_M / CROSSOVER_TAPER_M below.
const CROSSOVER_CAPTURE_RADIUS_M = 15;
// A candidate must be at least this far below to count as "meaningfully
// lower" at all -- kept small and separate from CROSSOVER_UNDERSIDE_GAP_M
// below (which controls how thick the resulting slab looks) so that
// re-tuning the visible thickness can't also change which s-ranges get
// detected as a crossover in the first place.
const CROSSOVER_MIN_DY_M = 3;
// How far above the lower section's own road height the slab's underside
// sits -- this is what sets the visible thickness of the "bridge deck"
// (ownY - floorY), not a literal measured clearance. Measured (03_plan.md
// P28 eighth follow-up): with the crossing's own ~6.2-6.3m elevation
// difference, a 3m gap left a ~3.2m-thick slab; the user asked for that
// visually "1/3 as thick" (user: "立体交差の板は、1/3の厚さにして"), so
// the gap was raised to leave ~1.07m instead.
const CROSSOVER_UNDERSIDE_GAP_M = 5.15;
// Padding added to a detected zone's measured s-extent before the taper
// starts, and the taper's own length once it does -- both in meters of s,
// not world-space distance (see findCrossoverZones()/floorForZones()).
// Sized generously against the ~10m coarse scan step above so a real zone
// is never clipped short.
const CROSSOVER_ZONE_PAD_M = 10;
const CROSSOVER_TAPER_M = 30;

// Same smoothstep shape as terrain.ts's falloff() (zero slope at both
// ends, so the taper's ends meet groundY and the flat zone tangentially,
// with no crease) -- duplicated rather than imported, matching this
// file's existing practice of mirroring a handful of small values from a
// sibling decorative module instead of coupling to it (see the header
// comment on HARBOR_EDGE_MARGIN_M in terrain.ts for the same reasoning).
function falloff(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - clamped * clamped * (3 - 2 * clamped);
}

interface CrossoverZone {
  start: number; // s, inclusive
  end: number; // s, inclusive
  floorY: number; // flat floor height held across [start, end]
}

/**
 * Finds contiguous s-ranges of the course that pass close over a
 * *different*, far-in-s part of the same course (Suzuka's figure-8
 * crossover) -- see buildEmbankment's own doc comment for why the
 * embankment cliff needs to stop early there instead of always reaching
 * groundY. Scans both edges' (x, z) trajectories coarsely; a zone is the
 * union of wherever either edge comes within CROSSOVER_CAPTURE_RADIUS_M of
 * a qualifying candidate.
 */
function findCrossoverZones(
  track: Track,
  courseKind: CourseKind,
  features: CourseFeature[],
  groundY: number,
  refPoints: { s: number; x: number; z: number; y: number }[],
): CrossoverZone[] {
  const hits: { s: number; targetY: number }[] = [];
  for (let s = 0; s < track.length; s += CROSSOVER_SAMPLE_STEP_M) {
    const sample = track.sampleAt(s);
    let bestTarget = -Infinity;
    for (const side of ["left", "right"] as const) {
      const edge = edgeAt(courseKind, track, sample, side, features);
      for (const p of refPoints) {
        if (Math.abs(p.s - s) < CROSSOVER_EXCLUDE_S_M) continue;
        if (p.y >= sample.position.y - CROSSOVER_MIN_DY_M) continue;
        const dx = edge.x - p.x;
        const dz = edge.z - p.z;
        if (dx * dx + dz * dz >= CROSSOVER_CAPTURE_RADIUS_M * CROSSOVER_CAPTURE_RADIUS_M) continue;
        const target = p.y + CROSSOVER_UNDERSIDE_GAP_M;
        if (target > bestTarget) bestTarget = target;
      }
    }
    if (bestTarget > groundY) hits.push({ s, targetY: bestTarget });
  }

  const zones: CrossoverZone[] = [];
  for (const hit of hits) {
    const last = zones[zones.length - 1];
    if (last && hit.s - last.end <= CROSSOVER_SAMPLE_STEP_M * 1.5) {
      last.end = hit.s;
      if (hit.targetY > last.floorY) last.floorY = hit.targetY;
    } else {
      zones.push({ start: hit.s, end: hit.s, floorY: hit.targetY });
    }
  }
  for (const zone of zones) {
    zone.start = Math.max(0, zone.start - CROSSOVER_ZONE_PAD_M);
    zone.end = Math.min(track.length, zone.end + CROSSOVER_ZONE_PAD_M);
  }
  return zones;
}

/** Flat within each zone, smoothstep-tapered back to groundY over
 * CROSSOVER_TAPER_M on either side -- see findCrossoverZones() above. */
function floorForZones(s: number, groundY: number, zones: CrossoverZone[]): number {
  let floor = groundY;
  for (const zone of zones) {
    let blended: number;
    if (s >= zone.start && s <= zone.end) {
      blended = zone.floorY;
    } else if (s < zone.start && zone.start - s <= CROSSOVER_TAPER_M) {
      blended = groundY + (zone.floorY - groundY) * falloff((zone.start - s) / CROSSOVER_TAPER_M);
    } else if (s > zone.end && s - zone.end <= CROSSOVER_TAPER_M) {
      blended = groundY + (zone.floorY - groundY) * falloff((s - zone.end) / CROSSOVER_TAPER_M);
    } else {
      continue;
    }
    if (blended > floor) floor = blended;
  }
  return floor;
}

/**
 * The auto-detected crossover zones (Suzuka's figure-8, findCrossoverZones()
 * above, unchanged) as their own padded s-ranges -- shared by
 * `buildCircuitEmbankment()`'s wall ribbon and `computeCircuitFenceAnchors()`
 * below, which both need to know exactly where that ribbon already covers
 * the gap so they don't overlap or double up (design 6.7.1, P30 eighth
 * follow-up).
 */
function circuitCrossoverZones(
  track: Track,
  courseKind: CourseKind,
  features: CourseFeature[],
  groundY: number,
): { zones: CrossoverZone[]; ranges: Array<{ sStart: number; sEnd: number }> } {
  const refPoints: { s: number; x: number; z: number; y: number }[] = [];
  for (let s = 0; s < track.length; s += CROSSOVER_SAMPLE_STEP_M) {
    const p = track.sampleAt(s).position;
    refPoints.push({ s, x: p.x, z: p.z, y: p.y });
  }
  const zones = findCrossoverZones(track, courseKind, features, groundY, refPoints);
  const ranges = zones.map((zone) => ({
    sStart: Math.max(0, zone.start - CROSSOVER_TAPER_M),
    sEnd: Math.min(track.length, zone.end + CROSSOVER_TAPER_M),
  }));
  return { zones, ranges };
}

/**
 * Suzuka (circuit courses): only at each auto-detected crossover zone
 * (Suzuka's figure-8) an open strip -- fixed floor within the zone,
 * tapering back toward `groundY` over its own `CROSSOVER_TAPER_M` -- in
 * `wallMaterial` (the course's usual embankment color). Everywhere else,
 * no ribbon at all: the terrain heightfield itself now rises to meet the
 * barrier there directly (render/terrain.ts's `fenceAnchors`, fed by
 * `computeCircuitFenceAnchors()` below) -- design 6.7.1, P30 eighth
 * follow-up, direct user request. An intermediate version of this file
 * instead drew a second, terrain-colored ribbon in the "elsewhere" ranges
 * (P30 sixth/seventh follow-up): color-matching it closed the visible seam,
 * but it was still a separate mesh standing in for the terrain rather than
 * the terrain itself starting at the barrier.
 */
function buildCircuitEmbankment(
  track: Track,
  courseKind: CourseKind,
  features: CourseFeature[],
  groundY: number,
  wallMaterial: THREE.Material,
): THREE.Group {
  const { zones: crossoverZones } = circuitCrossoverZones(track, courseKind, features, groundY);

  const group = new THREE.Group();
  group.name = "embankment";
  for (const side of ["left", "right"] as const) {
    const topAt = (sample: TrackSample) => edgeAt(courseKind, track, sample, side, features);

    for (const zone of crossoverZones) {
      const range = {
        sStart: Math.max(0, zone.start - CROSSOVER_TAPER_M),
        sEnd: Math.min(track.length, zone.end + CROSSOVER_TAPER_M),
      };
      const geometry = buildStrip(
        track,
        topAt,
        (sample) => {
          const edge = topAt(sample);
          return { x: edge.x, y: floorForZones(sample.s, groundY, [zone]), z: edge.z };
        },
        range,
      );
      group.add(new THREE.Mesh(geometry, wallMaterial));
    }
  }
  return group;
}

/**
 * Anchor points (design 6.7.1/6.7.2, P30 eighth follow-up) that pull
 * render/terrain.ts's heightfield up to touch this circuit's own barrier
 * line directly, everywhere except the crossover zones `
 * buildCircuitEmbankment()` already covers with its own flat "bridge deck"
 * ribbon (those must keep the terrain at its normal, lower height so the
 * deck reads as passing over it, not merging into it). Street courses
 * (Monaco) return no anchors: they keep the separate ground-shelf-edge
 * ribbon (`buildStreetEmbankment()` below) instead, since Monaco's
 * "elsewhere" edge is the *building* ground shelf, not the barrier -- a
 * concept the terrain heightfield has no notion of.
 */
export function computeCircuitFenceAnchors(
  track: Track,
  courseKind: CourseKind,
  features: CourseFeature[],
  groundY: number,
): { x: number; y: number; z: number }[] {
  if (courseKind !== "circuit") return [];

  const { ranges: zoneRanges } = circuitCrossoverZones(track, courseKind, features, groundY);

  const anchors: { x: number; y: number; z: number }[] = [];
  for (const side of ["left", "right"] as const) {
    for (const range of complementRanges(zoneRanges, track.length)) {
      for (let s = range.sStart; s < range.sEnd; s += CROSSOVER_SAMPLE_STEP_M) {
        anchors.push(edgeAt(courseKind, track, track.sampleAt(s), side, features));
      }
    }
  }
  return anchors;
}

/**
 * Monaco (street courses): two kinds of segments per side (design 6.7.1,
 * P30 third/fourth/seventh follow-ups):
 * 1. At each explicit `embankment` CourseFeature (Monaco's two hand-placed
 *    zones), an open strip at that feature's own fixed `floorY`, in
 *    `wallMaterial` (a pale stone tone matching the buildings above).
 * 2. Everywhere else, an open strip dropped to the terrain heightfield's
 *    own height at this exact (x, z), in `terrainMaterial` -- same
 *    reasoning and same "avoid a visible seam" fix as
 *    buildCircuitEmbankment()'s tier 2 above.
 *
 * No auto-detected crossover-zone tier here (unlike the circuit path
 * above): `findCrossoverZones()` does also fire on part of Monaco's Grand
 * Hotel Hairpin approach (03_plan.md P28 fifth follow-up's "副作用の確認"),
 * but that stretch already has its own explicit zone (1), which always
 * covers it -- see the two zones' s-ranges in course/catalog.ts.
 */
function buildStreetEmbankment(
  track: Track,
  courseKind: CourseKind,
  features: CourseFeature[],
  groundY: number,
  wallMaterial: THREE.Material,
  terrainMaterial: THREE.Material,
): THREE.Group {
  const embankmentFeatures = features.filter((f) => f.type === "embankment");
  const terrain = createTerrainSampler(track, groundY, features);

  const group = new THREE.Group();
  group.name = "embankment";
  for (const side of ["left", "right"] as const) {
    const topAt = (sample: TrackSample) => edgeAt(courseKind, track, sample, side, features);
    const sideFeatures = embankmentFeatures.filter((f) => f.side === undefined || f.side === side);

    for (const feature of sideFeatures) {
      const floorY = feature.floorY as number; // required for type "embankment", see catalog.ts
      for (const range of splitWrappingRange(feature.sStart, feature.sEnd, track.length)) {
        const geometry = buildStrip(track, topAt, (sample) => ({ ...topAt(sample), y: floorY }), range);
        group.add(new THREE.Mesh(geometry, wallMaterial));
      }
    }

    const zoneRanges = sideFeatures.flatMap((f) => splitWrappingRange(f.sStart, f.sEnd, track.length));
    for (const range of complementRanges(zoneRanges, track.length)) {
      const geometry = buildStrip(
        track,
        topAt,
        (sample) => {
          const edge = topAt(sample);
          return { x: edge.x, y: terrain.heightAt(edge.x, edge.z), z: edge.z };
        },
        range,
      );
      group.add(new THREE.Mesh(geometry, terrainMaterial));
    }
  }
  return group;
}

export function buildEmbankment(
  track: Track,
  courseKind: CourseKind,
  features: CourseFeature[],
  groundY: number,
): THREE.Group {
  // Street courses (Monaco): a pale stone tone matching the buildings
  // above (user: "壁面はビルの側面と同様の淡色系"). Other course kinds
  // (Suzuka's grass hillside) keep the darker GROUND_COLOR -- there's no
  // building palette to match there.
  const wallColor = courseKind === "street" ? EMBANKMENT_WALL_COLOR_STREET : GROUND_COLOR;
  const wallMaterial = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 1.0, side: THREE.DoubleSide });
  // Matches render/terrain.ts's own material exactly -- see this file's
  // "avoid a visible seam" comments above.
  const terrainMaterial = new THREE.MeshStandardMaterial({ color: TERRAIN_COLOR, roughness: 1.0, side: THREE.DoubleSide });

  return courseKind === "street"
    ? buildStreetEmbankment(track, courseKind, features, groundY, wallMaterial, terrainMaterial)
    : buildCircuitEmbankment(track, courseKind, features, groundY, wallMaterial);
}
