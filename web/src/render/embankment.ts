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
import { EMBANKMENT_WALL_COLOR_STREET } from "./cityScenery";

function edgeAt(
  courseKind: CourseKind,
  sample: TrackSample,
  side: "left" | "right",
  curbFeatures: CourseFeature[],
): { x: number; y: number; z: number } {
  const sign = side === "left" ? 1 : -1;
  return add(sample.position, scale(sample.normal, barrierOffsetAt(courseKind, sample, side, curbFeatures) * sign));
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
  curbFeatures: CourseFeature[],
  groundY: number,
  refPoints: { s: number; x: number; z: number; y: number }[],
): CrossoverZone[] {
  const hits: { s: number; targetY: number }[] = [];
  for (let s = 0; s < track.length; s += CROSSOVER_SAMPLE_STEP_M) {
    const sample = track.sampleAt(s);
    let bestTarget = -Infinity;
    for (const side of ["left", "right"] as const) {
      const edge = edgeAt(courseKind, sample, side, curbFeatures);
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
 * `groundY`: environment.ts's `EnvironmentHandles.groundY`, so this ribbon
 * always reaches exactly down to the ground plane regardless of course.
 *
 * Drops straight down from the barrier's own (x, z) line rather than also
 * pushing outward: an outward push risks the far rail crossing itself on
 * Monaco's tightest corners (the Grand Hotel Hairpin's ~6.7 m curvature
 * radius), the same failure mode buildings had in cityScenery.ts before
 * their clearance check (design 6.12, P11). Staying on the barrier's own
 * path can't newly self-intersect, since that ribbon already renders
 * cleanly everywhere.
 */
export function buildEmbankment(
  track: Track,
  courseKind: CourseKind,
  features: CourseFeature[],
  groundY: number,
): THREE.Group {
  const curbFeatures = features.filter((f) => f.type === "curb");
  // Street courses (Monaco): a pale stone tone matching the buildings
  // above (user: "壁面はビルの側面と同様の淡色系"). Other course kinds
  // (Suzuka's grass hillside) keep the darker GROUND_COLOR -- there's no
  // building palette to match there.
  const wallColor = courseKind === "street" ? EMBANKMENT_WALL_COLOR_STREET : GROUND_COLOR;
  const material = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 1.0, side: THREE.DoubleSide });

  const refPoints: { s: number; x: number; z: number; y: number }[] = [];
  for (let s = 0; s < track.length; s += CROSSOVER_SAMPLE_STEP_M) {
    const p = track.sampleAt(s).position;
    refPoints.push({ s, x: p.x, z: p.z, y: p.y });
  }
  const crossoverZones = findCrossoverZones(track, courseKind, curbFeatures, groundY, refPoints);

  const group = new THREE.Group();
  group.name = "embankment";
  for (const side of ["left", "right"] as const) {
    const geometry = buildStrip(
      track,
      (sample) => edgeAt(courseKind, sample, side, curbFeatures),
      (sample) => {
        const edge = edgeAt(courseKind, sample, side, curbFeatures);
        const floor = floorForZones(sample.s, groundY, crossoverZones);
        return { x: edge.x, y: floor, z: edge.z };
      },
    );
    group.add(new THREE.Mesh(geometry, material));
  }
  return group;
}
