/**
 * Monaco-style street-course scenery: roadside buildings, the tunnel under
 * the Fairmont/Grand Hotel, and the harbor front.
 *
 * Design ref: 02_design.md section 6.12. `features` (tunnel/harbor s
 * ranges) comes from course/catalog.ts, derived from monaco.json's actual
 * elevation/curvature data -- see that file's doc comment and design 6.12
 * for the derivation and its confidence level.
 */

import * as THREE from "three";
import { add, scale, lerp, vec3 } from "../sim/vec";
import type { Vec3 } from "../sim/vec";
import type { Track, TrackSample } from "../sim/track";
import type { CourseFeature } from "../course/catalog";
import { CURB_BAND, barrierOffsetAt } from "../sim/surface";
import { buildStrip, createRng } from "./scenery";
import { createCurbTexture, createWindowTexture } from "./textures";

const BUILDING_SPACING_M = 22;
const BUILDING_SETBACK_M = 3.0; // clear of the road edge/barrier
const BUILDING_MIN_HEIGHT_M = 8;
const BUILDING_MAX_HEIGHT_M = 28;
const BUILDING_MIN_WIDTH_M = 8;
const BUILDING_MAX_WIDTH_M = 16;
const BUILDING_MIN_DEPTH_M = 8;
const BUILDING_MAX_DEPTH_M = 14;
const BUILDING_TEXTURE_UNIT_M = 7; // meters per full window-grid tile

// Monaco street-front palette (design 6.12.1, P18 follow-up): the first
// version leaned into saturated ochre/terracotta/pink/blue-grey tones,
// which read as more "generic Mediterranean village" than Monaco's actual
// look -- dense white/cream high-rises and pale stone facades. Replaced
// with a tighter palette of near-white and pale beige/stone tones only
// (per user feedback: "もっと白、ベージュ系の淡い色がいい").
const BUILDING_PALETTE = [
  0xf7f3ea, 0xf5f0e6, 0xefe8d8, 0xf0ece0, 0xe8dfc8, 0xece4d0, 0xe3dbc6, 0xdcd2b8,
];
const ROOF_ACCENT_COLOR = 0xc9a888; // pale tan roof edge -- softened to match the paler wall palette above
const ROOF_ACCENT_HEIGHT_M = 0.3;

// Ground fill (design 6.7.1/6.12.3, P28 follow-up): user report "ビルが
// 浮いて見える" persisted after P28's barrier-line embankment curtain,
// because that curtain only closes the gap directly under the barrier's
// own path -- the flat area further out, where buildings actually stand
// (BUILDING_SETBACK_M plus their own footprint), still had no ground mesh
// at all. Also colors the requested surfaces (user: "縁石とガードレールの
// 間、ビルが立つ地面...灰色系"): a plain warm-grey pavement tone, distinct
// from both the asphalt and the far ground plane's darker GROUND_COLOR.
const STREET_GROUND_COLOR = 0x8f8c82;
// How far past a building's own bounding radius the ground shelf reaches,
// so it peeks out slightly beyond the widest building's silhouette instead
// of stopping exactly at its edge.
const GROUND_SHELF_MARGIN_M = 2.0;
// Ground shelf reach beyond the barrier line (design 6.7.1 second
// follow-up): sized for the widest possible building (BUILDING_MAX_WIDTH_M
// / BUILDING_MAX_DEPTH_M), so the shelf comfortably reaches every placed
// building's footprint. `buildStreetGround()` below clamps this per-sample
// where the actual curvature can't tolerate it (Monaco's tight corners).
const GROUND_SHELF_REACH_M =
  BUILDING_SETBACK_M + Math.hypot(BUILDING_MAX_WIDTH_M, BUILDING_MAX_DEPTH_M) / 2 + GROUND_SHELF_MARGIN_M;
// How much margin to keep on `1 - curvature*d` (design 6.3.3's own Frenet
// term, dropped there for the physics but relevant here for geometry): an
// offset curve folds on itself once this denominator reaches 0. Chosen
// comfortably above 0, not against it, since clamping is per-sample and a
// thin margin could still visibly wobble between samples.
const GROUND_SHELF_SAFE_DENOM_MIN = 0.4;
// How far ahead/behind along s to look for upcoming tight curvature when
// deciding how far the shelf should reach (see the comment on `outerEdge`
// in buildStreetGround()). 90m (03_plan.md P29 fourth follow-up) removed
// the original roof-shaped overhang at the hairpin's own tightest point,
// but a nearby, still-full-width stretch (s~1260, ~40m further along)
// remained visible as a smaller stray sliver from a low, close-up chase
// camera (screenshot: MonacoChase10.png) -- raised to 150m (03_plan.md P29
// sixth follow-up) so the taper reaches far enough out from the apex to
// cover that stretch too, verified by re-checking that same viewpoint.
const GROUND_SHELF_TAPER_LOOKAHEAD_M = 150;
// Below TAPER_LOW, curvature is gentle enough that the full reach is kept;
// above TAPER_HIGH, the reach tapers to (nearly) nothing, well short of
// `shelfCap`'s hard fold limit so the taper -- not the fold clamp -- is
// what's normally shaping the shelf near a tight corner. An earlier, much
// lower TAPER_LOW (0.02) tapered nearly half the course's building
// placements away (03_plan.md P29 fifth follow-up) -- measured, Monaco has
// 11 separate corners with curvature > 0.05 (radius < 20m), and ordinary
// corners routinely reach curvature ~0.05-0.07 without ever needing
// `shelfCap` to clamp them at all (that only starts binding above ~0.038
// for the untapered reach). Only the Grand Hotel Hairpin's apex reaches
// past 0.1 (peak 0.143, the single sharpest point on either course) --
// TAPER_LOW/HIGH are set just above/below that peak so the taper is
// specific to the one corner it exists for, leaving every ordinary corner
// at full reach exactly as before this feature.
const GROUND_SHELF_TAPER_LOW = 0.07;
const GROUND_SHELF_TAPER_HIGH = 0.13;

/** Smoothstep from 0 (curvature <= TAPER_LOW) to 1 (curvature >= TAPER_HIGH). */
function taperFalloff(curvature: number): number {
  const t = (curvature - GROUND_SHELF_TAPER_LOW) / (GROUND_SHELF_TAPER_HIGH - GROUND_SHELF_TAPER_LOW);
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * (3 - 2 * clamped);
}

/** Max |curvature| within `lookaheadM` of `s` in either direction, wrapping around a closed loop. */
function nearbyMaxCurvature(track: Track, s: number, lookaheadM: number): number {
  const ds = track.ds;
  let max = 0;
  for (let ds_ = -lookaheadM; ds_ <= lookaheadM; ds_ += ds) {
    const c = Math.abs(track.sampleAt(s + ds_).curvature);
    if (c > max) max = c;
  }
  return max;
}

// Embankment cliff color for street courses (render/embankment.ts, P28
// follow-up, user: "壁面はビルの側面と同様の淡色系"): reuses one of
// BUILDING_PALETTE's tones so the cliff face reads as more of the same
// pale stone as the buildings above it, not as bare dirt. Exported instead
// of duplicated so the two files can't drift apart.
export const EMBANKMENT_WALL_COLOR_STREET = 0xe3dbc6;

const TUNNEL_WALL_MARGIN_M = 1.0;
const TUNNEL_CEILING_HEIGHT_M = 4.5;
const TUNNEL_LIGHT_HALF_WIDTH_M = 0.4;

const HARBOR_EDGE_MARGIN_M = 1.5;
const HARBOR_WATER_WIDTH_M = 45;
const BOAT_SPACING_M = 55;
const BOAT_SKIP_PROBABILITY = 0.25;

const CLEARANCE_CHECK_STEP_M = 3; // coarse sampling for the overlap checks below
const CLEARANCE_MARGIN_M = 1.0;

// Curb corners (design 6.12.2/6.13.5, P27). Height/tile length match
// render/circuitScenery.ts's CURB_HEIGHT_M/CURB_TILE_M -- same physical
// curb, same render treatment, just not worth importing a render-only
// constant across files for. The width, by contrast, is physics-derived
// (it's also the band stepVehicle() grips on), so it comes from
// sim/surface.ts's CURB_BAND instead of a second hardcoded copy.
const MONACO_CURB_HEIGHT_M = 0.05;
const MONACO_CURB_TILE_M = 4;

/**
 * `sStart > sEnd` (P30) means the range wraps past the loop's s=0 seam
 * instead of an ordinary sStart-to-sEnd span -- see the CourseFeature doc
 * comment (course/catalog.ts) and design 6.12.3. Every pre-P30 feature has
 * sStart < sEnd, so this is unchanged for them.
 */
function inRange(s: number, feature: CourseFeature): boolean {
  const { sStart, sEnd } = feature;
  return sStart <= sEnd ? s >= sStart && s < sEnd : s >= sStart || s < sEnd;
}

/**
 * Whether a point (with the given bounding radius) stays clear of the road
 * corridor everywhere on the loop, not just at its own placement `s`.
 *
 * Found empirically (not by inspection -- see the analysis script referenced
 * in 03_plan.md P11): buildings are unrotated boxes placed at a fixed
 * lateral setback from their *own* sample's road edge, but Monaco's tighter
 * corners (Beau Rivage's bends, the Fairmont hairpin) curve back on
 * themselves within less distance than that setback, so a chunk of the box
 * ends up sitting on the road surface a few (up to ~130 m of arc length in
 * the worst case) meters away. Checking against every sample instead of
 * just the placement one catches this.
 */
function clearsRoad(track: Track, point: Vec3, radius: number): boolean {
  for (let s = 0; s < track.length; s += CLEARANCE_CHECK_STEP_M) {
    const sample = track.sampleAt(s);
    const dist = Math.hypot(point.x - sample.position.x, point.z - sample.position.z);
    const roadHalf = Math.max(sample.widthLeft, sample.widthRight);
    if (dist < roadHalf + radius + CLEARANCE_MARGIN_M) return false;
  }
  return true;
}

/**
 * Whether a point stays clear of a harbor feature's water strip, checked
 * across the feature's whole s range regardless of the point's own s --
 * Monaco is compact enough that a building from a different part of the
 * course (e.g. the Beau Rivage climb) can sit geometrically right over the
 * harbor water when viewed from across it, which reads as "floating".
 */
function clearsHarborWater(track: Track, harbor: CourseFeature, point: Vec3, radius: number): boolean {
  const side = harbor.side ?? "right";
  const sign = side === "left" ? 1 : -1;
  const halfWaterWidth = HARBOR_WATER_WIDTH_M / 2;
  for (let s = harbor.sStart; s < harbor.sEnd; s += CLEARANCE_CHECK_STEP_M) {
    const sample = track.sampleAt(s);
    const half = side === "left" ? sample.widthLeft : sample.widthRight;
    const centerOffset = (half + HARBOR_EDGE_MARGIN_M + halfWaterWidth) * sign;
    const center = add(sample.position, scale(sample.normal, centerOffset));
    const dist = Math.hypot(point.x - center.x, point.z - center.z);
    if (dist < halfWaterWidth + radius + CLEARANCE_MARGIN_M) return false;
  }
  return true;
}

export function buildCityScenery(track: Track, features: CourseFeature[], groundY: number): THREE.Group {
  const group = new THREE.Group();
  group.name = "cityScenery";

  const tunnel = features.find((f) => f.type === "tunnel");
  const harbor = features.find((f) => f.type === "harbor");

  group.add(buildBuildings(track, tunnel, harbor, features));
  if (tunnel) group.add(buildTunnel(track, tunnel));
  if (harbor) group.add(buildHarbor(track, harbor));
  group.add(buildMonacoCurbs(track, features));
  group.add(buildStreetGround(track, features, groundY));
  return group;
}

/**
 * The largest offset (signed by `sign`, `curvature*sign > 0` meaning
 * further out pulls the offset curve tighter) that keeps the Frenet
 * offset-curve denominator `1 - curvature*d` at or above
 * `GROUND_SHELF_SAFE_DENOM_MIN` -- `Infinity` when the turn direction never
 * folds (`curvature*sign <= 0`, the *outside* of a turn). Measured, not
 * assumed (03_plan.md P28 second follow-up): a uniform +20m reach folds
 * badly on Monaco's tightest corners -- e.g. denom = -2.75 at the Grand
 * Hotel Hairpin's inside edge (s=1217) and -0.78 near Portier (s=1373).
 */
function shelfCap(curvature: number, sign: number): number {
  const k = curvature * sign;
  if (k <= 0) return Infinity;
  return (1 - GROUND_SHELF_SAFE_DENOM_MIN) / k;
}

/**
 * Ground fill from the curb (or paved edge, where there's no curb) out to
 * a shelf reaching past where buildings stand (design 6.7.1, two P28
 * follow-ups). The first follow-up gave each building its own isolated
 * ground pad in its own local (tangent, normal) frame; that avoided
 * self-intersection but, being one flat quad per building, left visible
 * gaps between buildings spaced further apart than the pad's width, and
 * -- since a straight quad edge doesn't track the road's actual curve --
 * could drift onto the road on a bend. Both are fixed by making this one
 * continuous strip per side (`buildStrip`, like the rest of this file's
 * ribbons) with the outer edge clamped by `shelfCap()` above instead of a
 * fixed reach.
 *
 * Within the harbor's water side, the shelf stops at the barrier (no
 * building-reaching extra) -- that space is water (render/cityScenery.ts's
 * `buildHarbor()`), not ground.
 */
/**
 * How far out (along `normal`, unsigned) the street ground shelf reaches
 * for this sample/side -- i.e. the outer boundary of the surface buildings
 * actually stand on, not just the barrier line. Exported so
 * render/embankment.ts can start its terrain-connecting cliff from this
 * same boundary instead of the barrier (design 6.7.1, P30 fifth
 * follow-up, user request): previously the cliff started at the barrier
 * while this shelf's *visible* ground continued on past it (up to
 * `GROUND_SHELF_REACH_M` further), leaving that outer strip of ground --
 * and whatever building stands past it -- with nothing connecting it down
 * to the terrain, i.e. still "floating" by the same P28 definition even
 * though the barrier itself was covered.
 */
export function groundShelfOffset(track: Track, sample: TrackSample, side: "left" | "right", features: CourseFeature[]): number {
  const sign = side === "left" ? 1 : -1;
  const curbFeatures = features.filter((f) => f.type === "curb");
  const harbor = features.find((f) => f.type === "harbor");
  const noBuildingZones = features.filter((f) => f.type === "noBuilding");
  const barrierOffset = barrierOffsetAt("street", sample, side, curbFeatures);
  const isHarborWaterSide = harbor !== undefined && inRange(sample.s, harbor) && (harbor.side ?? "right") === side;
  const isNoBuildingSide = noBuildingZones.some((f) => (f.side === undefined || f.side === side) && inRange(sample.s, f));
  if (isHarborWaterSide || isNoBuildingSide) return barrierOffset;
  const tightness = nearbyMaxCurvature(track, sample.s, GROUND_SHELF_TAPER_LOOKAHEAD_M);
  const taper = taperFalloff(tightness);
  const reach = GROUND_SHELF_REACH_M * (1 - taper);
  const cap = shelfCap(sample.curvature, sign);
  return Math.max(barrierOffset, Math.min(barrierOffset + reach, cap));
}

function buildStreetGround(track: Track, features: CourseFeature[], groundY: number): THREE.Group {
  const group = new THREE.Group();
  group.name = "streetGround";
  const curbFeatures = features.filter((f) => f.type === "curb");
  const material = new THREE.MeshStandardMaterial({ color: STREET_GROUND_COLOR, roughness: 1.0, side: THREE.DoubleSide });

  const inCurbZone = (s: number, side: "left" | "right"): boolean =>
    curbFeatures.some((f) => (f.side === undefined || f.side === side) && inRange(s, f));

  for (const side of ["left", "right"] as const) {
    const sign = side === "left" ? 1 : -1;
    const innerEdge = (sample: TrackSample): Vec3 => {
      const halfWidth = side === "left" ? sample.widthLeft : sample.widthRight;
      const curbWidth = inCurbZone(sample.s, side) ? CURB_BAND.width : 0;
      return add(sample.position, scale(sample.normal, (halfWidth + curbWidth) * sign));
    };
    // `shelfCap` only bounds a single sample against folding *at that
    // sample* -- a hairpin as tight as the Grand Hotel Hairpin (~7m turning
    // radius at its apex) still forces the reach down to near the barrier
    // right at the peak, no matter the safety margin (verified: even at
    // zero margin the fold-radius itself caps the reach at ~7m there). What
    // it doesn't prevent is the FULL (~20-26m) reach persisting right up
    // until the last moment beforehand: from a low cockpit camera already
    // deep into the tightening turn, that nearby, still-full-width shelf --
    // correctly placed by its own local math -- ends up laterally behind
    // and above the driving line (the road has curved back on itself
    // faster than the shelf's own width shrinks), reading as an
    // overhanging "roof" with a gap of open sky where the shelf hasn't
    // caught up to shrinking yet (screenshot: MonacoChase9.png; confirmed
    // by hiding every other mesh and raycasting -- the roof shape is this
    // same shelf, ~7m from the camera, and the sky gap is an unobstructed
    // view past both the shelf and the P29 terrain heightfield, not a
    // self-intersection). `nearbyMaxCurvature` looks `GROUND_SHELF_TAPER_LOOKAHEAD_M`
    // ahead and behind along s (not just at the current sample) so the
    // *desired* reach itself starts shrinking well before the fold-safety
    // clamp would otherwise force it to, giving the shelf enough track
    // distance to taper down gradually ahead of a tight corner instead of
    // still being full width right next to it.
    //
    // Narrowing the reach alone still leaves a flat plate sitting at the
    // *road's own* height, and that plate is still what a low camera deep
    // in the fold-back sees end-on -- narrower didn't stop it from reading
    // as a floating slab (user: "土砂崩れみたいになっている" even after the
    // reach taper, 03_plan.md P29 sixth follow-up). The user's own
    // suggestion was to stop treating this as a slope that has to blend
    // smoothly at all -- a cliff dropping away is a perfectly normal thing
    // to see next to a hairpin. So the same taper fraction that shrinks the
    // reach also pulls the outer edge's *height* down toward `groundY`:
    // full taper means the outer edge is both at the curb and down at
    // ground level, i.e. a wall, not a shrinking horizontal shelf.
    const outerEdge = (sample: TrackSample): Vec3 => {
      const offset = groundShelfOffset(track, sample, side, features);
      const point = add(sample.position, scale(sample.normal, offset * sign));
      // Height still tapers toward `groundY` near a tight corner (see this
      // function's header comment above) -- unrelated to the horizontal
      // reach itself, so it stays local to this ground shelf rather than
      // moving into `groundShelfOffset()`.
      const tightness = nearbyMaxCurvature(track, sample.s, GROUND_SHELF_TAPER_LOOKAHEAD_M);
      const taper = taperFalloff(tightness);
      return { x: point.x, y: sample.position.y + (groundY - sample.position.y) * taper, z: point.z };
    };
    const geometry = buildStrip(track, innerEdge, outerEdge);
    group.add(new THREE.Mesh(geometry, material));
  }
  return group;
}

/**
 * Curb ribbons for the specific corners that have one in reality (design
 * 6.13.5, P27) -- unlike render/circuitScenery.ts's `buildCurbs`, this is a
 * handful of open partial strips (one per `curb` CourseFeature, `side`
 * either side), not a closed ribbon around the whole course, since most of
 * Monaco's edge is still wall-right-at-the-paved-edge (requirement 4.7.3).
 */
function buildMonacoCurbs(track: Track, features: CourseFeature[]): THREE.Group {
  const group = new THREE.Group();
  group.name = "curbs";
  const texture = createCurbTexture();
  const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.7, side: THREE.DoubleSide });

  const edgeAt = (sample: TrackSample, side: "left" | "right", offset: number): Vec3 => {
    const halfWidth = side === "left" ? sample.widthLeft : sample.widthRight;
    const sign = side === "left" ? 1 : -1;
    return add(sample.position, scale(sample.normal, (halfWidth + offset) * sign));
  };

  for (const feature of features.filter((f) => f.type === "curb")) {
    const range = { sStart: feature.sStart, sEnd: feature.sEnd };
    const sides = feature.side ? [feature.side] : (["left", "right"] as const);
    for (const side of sides) {
      const inner = (sample: TrackSample): Vec3 => add(edgeAt(sample, side, 0), vec3(0, MONACO_CURB_HEIGHT_M, 0));
      const outer = (sample: TrackSample): Vec3 =>
        add(edgeAt(sample, side, CURB_BAND.width), vec3(0, MONACO_CURB_HEIGHT_M, 0));
      const geometry = buildStrip(track, inner, outer, range, MONACO_CURB_TILE_M);
      group.add(new THREE.Mesh(geometry, material));
    }
  }
  return group;
}

function buildBuildings(
  track: Track,
  tunnel: CourseFeature | undefined,
  harbor: CourseFeature | undefined,
  features: CourseFeature[],
): THREE.Group {
  const group = new THREE.Group();
  group.name = "buildings";
  const rng = createRng(1);
  const windowTexture = createWindowTexture();
  const roofAccentMaterial = new THREE.MeshStandardMaterial({ color: ROOF_ACCENT_COLOR, roughness: 0.8 });
  const noBuildingZones = features.filter((f) => f.type === "noBuilding");

  for (let s = 0; s < track.length; s += BUILDING_SPACING_M) {
    const sample = track.sampleAt(s);
    for (const side of ["left", "right"] as const) {
      if (tunnel && inRange(s, tunnel)) continue; // covered by the tunnel structure
      if (harbor && inRange(s, harbor) && (harbor.side ?? "right") === side) continue; // water side only -- the inland side keeps its buildings
      // design 6.12.3 (P30): direct user request to keep one side clear of
      // buildings over a given stretch, independent of tunnel/harbor.
      if (noBuildingZones.some((f) => (f.side === undefined || f.side === side) && inRange(s, f))) continue;

      const height = BUILDING_MIN_HEIGHT_M + rng() * (BUILDING_MAX_HEIGHT_M - BUILDING_MIN_HEIGHT_M);
      const width = BUILDING_MIN_WIDTH_M + rng() * (BUILDING_MAX_WIDTH_M - BUILDING_MIN_WIDTH_M);
      const depth = BUILDING_MIN_DEPTH_M + rng() * (BUILDING_MAX_DEPTH_M - BUILDING_MIN_DEPTH_M);
      const halfWidthRoad = side === "left" ? sample.widthLeft : sample.widthRight;
      const sign = side === "left" ? 1 : -1;
      // The box is unrotated (world-axis-aligned) while `normal` turns with
      // the road, so its true reach along the push direction can be
      // anywhere between `depth/2` and the full bounding (circumscribed)
      // radius depending on heading. Push out by the radius, not `depth/2`,
      // so the clearance check below always passes at the building's own
      // placement sample (an earlier `depth/2` version failed its own
      // check for most buildings -- see 03_plan.md P11).
      const boundingRadius = Math.hypot(width, depth) / 2;
      const offset = halfWidthRoad + BUILDING_SETBACK_M + boundingRadius;

      const base = add(sample.position, scale(sample.normal, offset * sign));
      if (!clearsRoad(track, base, boundingRadius)) continue;
      if (harbor && !clearsHarborWater(track, harbor, base, boundingRadius)) continue;
      // buildStreetGround() tapers the ground shelf's reach down near a
      // tight corner (see its own comment) -- without this check, a
      // building placed at its usual fixed setback would end up beyond
      // that (now-shrunk) shelf edge and read as floating with a visible
      // gap beneath it (found by testing the taper itself: 03_plan.md P29
      // fourth follow-up). Skipping it here keeps every building backed by
      // *some* ground shelf, the same guarantee `clearsRoad`/
      // `clearsHarborWater` give against the other two failure modes.
      const barrierOffset = barrierOffsetAt("street", sample, side);
      const tightness = nearbyMaxCurvature(track, s, GROUND_SHELF_TAPER_LOOKAHEAD_M);
      const shelfReach = barrierOffset + GROUND_SHELF_REACH_M * (1 - taperFalloff(tightness));
      // Compare the building's *center* (`offset`), not its far edge
      // (`offset + boundingRadius`), against the shelf's reach: untapered,
      // `GROUND_SHELF_REACH_M` was only ever sized to reach a building's
      // center plus `GROUND_SHELF_MARGIN_M` (design 6.7.1 second
      // follow-up's own derivation), never its full far edge -- checking
      // against the far edge made this condition fail almost everywhere,
      // not just near tight corners (found from the user's report that
      // buildings had nearly all disappeared; verified by a headless count
      // showing 100% of candidates rejected, 03_plan.md P29 fifth
      // follow-up). Matching the same tolerance the untapered shelf always
      // had keeps this check specific to the taper's own effect.
      if (offset > shelfReach) continue;

      const texture = windowTexture.clone();
      texture.repeat.set(width / BUILDING_TEXTURE_UNIT_M, height / BUILDING_TEXTURE_UNIT_M);
      const material = new THREE.MeshStandardMaterial({
        map: texture,
        color: BUILDING_PALETTE[Math.floor(rng() * BUILDING_PALETTE.length)],
        roughness: 0.85,
      });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
      mesh.position.set(base.x, base.y + height / 2, base.z);
      group.add(mesh);

      // Roof-edge accent (design 6.12.1): a slightly larger, thin box
      // capping the roof, so the silhouette reads as a building with a
      // rooftop rather than a plain unadorned box.
      const roofAccent = new THREE.Mesh(
        new THREE.BoxGeometry(width * 1.04, ROOF_ACCENT_HEIGHT_M, depth * 1.04),
        roofAccentMaterial,
      );
      roofAccent.position.set(base.x, base.y + height + ROOF_ACCENT_HEIGHT_M / 2, base.z);
      group.add(roofAccent);
    }
  }
  return group;
}

function buildTunnel(track: Track, feature: CourseFeature): THREE.Group {
  const group = new THREE.Group();
  group.name = "tunnel";
  const range = { sStart: feature.sStart, sEnd: feature.sEnd };

  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0x54595e,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });
  const lightMaterial = new THREE.MeshStandardMaterial({
    color: 0x8a8560,
    emissive: 0xdcd090,
    emissiveIntensity: 0.6,
    side: THREE.DoubleSide,
  });

  const leftEdge = (sample: TrackSample): Vec3 =>
    add(sample.position, scale(sample.normal, sample.widthLeft + TUNNEL_WALL_MARGIN_M));
  const rightEdge = (sample: TrackSample): Vec3 =>
    add(sample.position, scale(sample.normal, -(sample.widthRight + TUNNEL_WALL_MARGIN_M)));
  const leftTop = (sample: TrackSample): Vec3 => add(leftEdge(sample), vec3(0, TUNNEL_CEILING_HEIGHT_M, 0));
  const rightTop = (sample: TrackSample): Vec3 => add(rightEdge(sample), vec3(0, TUNNEL_CEILING_HEIGHT_M, 0));
  const lightInner = (sample: TrackSample): Vec3 =>
    add(sample.position, add(scale(sample.normal, -TUNNEL_LIGHT_HALF_WIDTH_M), vec3(0, TUNNEL_CEILING_HEIGHT_M - 0.03, 0)));
  const lightOuter = (sample: TrackSample): Vec3 =>
    add(sample.position, add(scale(sample.normal, TUNNEL_LIGHT_HALF_WIDTH_M), vec3(0, TUNNEL_CEILING_HEIGHT_M - 0.03, 0)));

  group.add(new THREE.Mesh(buildStrip(track, leftEdge, leftTop, range), wallMaterial));
  group.add(new THREE.Mesh(buildStrip(track, rightEdge, rightTop, range), wallMaterial));
  group.add(new THREE.Mesh(buildStrip(track, leftTop, rightTop, range), wallMaterial));
  group.add(new THREE.Mesh(buildStrip(track, lightInner, lightOuter, range), lightMaterial));
  return group;
}

function buildHarbor(track: Track, feature: CourseFeature): THREE.Group {
  const group = new THREE.Group();
  group.name = "harbor";
  const range = { sStart: feature.sStart, sEnd: feature.sEnd };
  const side = feature.side ?? "right";
  const sign = side === "left" ? 1 : -1;

  const waterMaterial = new THREE.MeshStandardMaterial({
    color: 0x1b4f6b,
    roughness: 0.3,
    metalness: 0.1,
    side: THREE.DoubleSide,
  });

  const innerEdge = (sample: TrackSample): Vec3 => {
    const half = side === "left" ? sample.widthLeft : sample.widthRight;
    return add(sample.position, add(scale(sample.normal, (half + HARBOR_EDGE_MARGIN_M) * sign), vec3(0, -0.1, 0)));
  };
  const outerEdge = (sample: TrackSample): Vec3 => {
    const half = side === "left" ? sample.widthLeft : sample.widthRight;
    return add(
      sample.position,
      add(scale(sample.normal, (half + HARBOR_EDGE_MARGIN_M + HARBOR_WATER_WIDTH_M) * sign), vec3(0, -0.1, 0)),
    );
  };

  group.add(new THREE.Mesh(buildStrip(track, innerEdge, outerEdge, range), waterMaterial));
  group.add(buildBoats(track, feature, innerEdge, outerEdge));
  return group;
}

function buildBoats(
  track: Track,
  feature: CourseFeature,
  innerEdge: (sample: TrackSample) => Vec3,
  outerEdge: (sample: TrackSample) => Vec3,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "boats";
  const rng = createRng(7);
  const hullMaterial = new THREE.MeshStandardMaterial({ color: 0xf2f0e6, roughness: 0.5 });
  const cabinMaterial = new THREE.MeshStandardMaterial({ color: 0x2d3742, roughness: 0.6 });

  for (let s = feature.sStart; s < feature.sEnd; s += BOAT_SPACING_M) {
    if (rng() < BOAT_SKIP_PROBABILITY) continue;

    const sample = track.sampleAt(s + rng() * BOAT_SPACING_M * 0.5);
    const t = 0.2 + rng() * 0.5;
    const base = lerp(innerEdge(sample), outerEdge(sample), t);

    const hullLength = 4 + rng() * 3;
    const hullWidth = 1.4 + rng() * 0.8;
    const hullHeight = 1.0 + rng() * 0.4;

    const boat = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.BoxGeometry(hullWidth, hullHeight, hullLength), hullMaterial);
    hull.position.y = hullHeight / 2;
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(hullWidth * 0.6, hullHeight * 0.8, hullLength * 0.35),
      cabinMaterial,
    );
    cabin.position.set(0, hullHeight + (hullHeight * 0.8) / 2, -hullLength * 0.15);
    boat.add(hull, cabin);

    boat.position.set(base.x, base.y, base.z);
    boat.up.set(sample.up.x, sample.up.y, sample.up.z);
    boat.lookAt(base.x + sample.tangent.x, base.y + sample.tangent.y, base.z + sample.tangent.z);
    group.add(boat);
  }
  return group;
}
