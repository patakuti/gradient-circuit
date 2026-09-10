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
import { buildStrip, createRng } from "./scenery";
import { createWindowTexture } from "./textures";

const BUILDING_SPACING_M = 22;
const BUILDING_SETBACK_M = 3.0; // clear of the road edge/barrier
const BUILDING_MIN_HEIGHT_M = 8;
const BUILDING_MAX_HEIGHT_M = 28;
const BUILDING_MIN_WIDTH_M = 8;
const BUILDING_MAX_WIDTH_M = 16;
const BUILDING_MIN_DEPTH_M = 8;
const BUILDING_MAX_DEPTH_M = 14;
const BUILDING_TEXTURE_UNIT_M = 7; // meters per full window-grid tile

const BUILDING_PALETTE = [0xd8c9a8, 0xc9b79a, 0xb8a488, 0xd9d4c4, 0xc4b8a0];

const TUNNEL_WALL_MARGIN_M = 1.0;
const TUNNEL_CEILING_HEIGHT_M = 4.5;
const TUNNEL_LIGHT_HALF_WIDTH_M = 0.4;

const HARBOR_EDGE_MARGIN_M = 1.5;
const HARBOR_WATER_WIDTH_M = 45;
const BOAT_SPACING_M = 55;
const BOAT_SKIP_PROBABILITY = 0.25;

const CLEARANCE_CHECK_STEP_M = 3; // coarse sampling for the overlap checks below
const CLEARANCE_MARGIN_M = 1.0;

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
