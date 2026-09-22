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
import { CURB_BAND } from "../sim/surface";
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

function inRange(s: number, feature: CourseFeature): boolean {
  return s >= feature.sStart && s < feature.sEnd;
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

export function buildCityScenery(track: Track, features: CourseFeature[]): THREE.Group {
  const group = new THREE.Group();
  group.name = "cityScenery";

  const tunnel = features.find((f) => f.type === "tunnel");
  const harbor = features.find((f) => f.type === "harbor");

  group.add(buildBuildings(track, tunnel, harbor));
  if (tunnel) group.add(buildTunnel(track, tunnel));
  if (harbor) group.add(buildHarbor(track, harbor));
  group.add(buildMonacoCurbs(track, features));
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
): THREE.Group {
  const group = new THREE.Group();
  group.name = "buildings";
  const rng = createRng(1);
  const windowTexture = createWindowTexture();
  const roofAccentMaterial = new THREE.MeshStandardMaterial({ color: ROOF_ACCENT_COLOR, roughness: 0.8 });

  for (let s = 0; s < track.length; s += BUILDING_SPACING_M) {
    const sample = track.sampleAt(s);
    for (const side of ["left", "right"] as const) {
      if (tunnel && inRange(s, tunnel)) continue; // covered by the tunnel structure
      if (harbor && inRange(s, harbor) && (harbor.side ?? "right") === side) continue; // water side only -- the inland side keeps its buildings

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
