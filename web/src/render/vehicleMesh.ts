/**
 * Procedurally generated vehicle body: an open-wheeler-style silhouette
 * (tapered nose + front wing, cockpit/engine-cover tub with side pods, a
 * halo over the cockpit, rear wing on struts, four wheels with a rim
 * accent). No external 3D model files (same "no external assets" policy
 * as render/textures.ts and audio/engine.ts).
 *
 * Design ref: 02_design.md sections 6.8 / 6.8.1. Shown from both the chase
 * and cockpit cameras. Unlike `Camera.lookAt` (-Z at the target), a plain
 * `Object3D.lookAt` -- what `main.ts` calls -- points local **+Z** at the
 * target, so every part ahead of the driver (nose, front wing) sits at
 * +Z and every part behind (cockpit tub, side pods, rear wing) at -Z;
 * after `main.ts` calls `mesh.lookAt(position + forward)`, +Z points along
 * `forward`.
 *
 * The nose stays narrow and low (design 6.8): a wide flat top surface
 * directly ahead of cockpitRig's eye visually walls off the forward view
 * (a near-horizontal surface just below eye height reads as an
 * unavoidable "horizon-filling" plane, regardless of how far below the
 * eye it sits) -- discovered by actually driving it. Everything else is
 * either narrow (front wing), or behind the eye and so outside the
 * cockpit's forward view frustum entirely (rear tub, side pods, rear
 * wing, halo), so it can be taller/wider without that problem.
 */

import * as THREE from "three";
import { createNumberDecalTexture } from "./textures";

const GROUND_CLEARANCE = 0.25; // ride height shared by the whole body

const NOSE_LENGTH = 1.8;
const NOSE_BASE_RADIUS = 0.25; // root radius, matches the old NOSE_WIDTH/2
const NOSE_TIP_RADIUS = 0.08; // design 6.8.1: tapered instead of a flat-fronted box
const NOSE_VERTICAL_SCALE = 0.6; // flattens the circular cross-section so the top stays at 0.55 m (see design 6.8.1)
const NOSE_RADIAL_SEGMENTS = 12;

const REAR_LENGTH = 2.4;
const REAR_WIDTH = 1.6;
const REAR_HEIGHT = 0.55; // top = 0.8 m; behind the eye point, out of the forward view

// Wedge-shaped engine cover (design 6.8.1, second follow-up): replaces a
// flat box with a shape that's wide at the floor and narrows to a spine at
// the top -- an *upright* CylinderGeometry (its natural Y axis is already
// vertical, no rotation needed) stretched lengthwise via scale.z. User
// feedback on the straight-box version, even after the
// two-tone/halo/endplate-accent follow-up: "もっとスマートにかっこよくして
// 欲しい" (make it look sleeker) -- a flat-sided box reads as "boxy"
// regardless of livery, so the shape itself needed to change.
//
// An earlier version of this instead tapered the shape *lengthwise*
// (narrow tail, wide cockpit end, laid along Z the same way as the nose).
// That taper doesn't read from a chase camera sitting almost directly
// behind the car looking straight down the taper axis -- it just looked
// like a rounded bucket, found by comparing chase-view screenshots. A
// taper that narrows going *up* (wide floor to narrow spine) is visible
// head-on from directly behind, which a lengthwise taper isn't.
const REAR_COVER_BOTTOM_RADIUS = REAR_WIDTH / 2; // wide at the floor, matches the old box width
const REAR_COVER_TOP_RADIUS = 0.35; // narrows to a spine, leading into the fin above
// 4 sides instead of a smooth many-sided cone (design 6.8.1, third
// follow-up): a `CylinderGeometry`'s side count is also its cross-section
// polygon, so 4 sides make a square frustum -- a flat panel facing the
// tail (user: "最後尾は四角い断面になっていた方がいい", the rear-most
// cross-section should be square) and flat left/right panels besides,
// which the side stripe below sits flush against. `rotation.y = 45deg`
// below centers those flat faces on the +-X/+-Z axes instead of leaving
// vertices there (`CylinderGeometry`'s first vertex sits on +X by default,
// which centers *edges*, not faces, on the axes).
const REAR_COVER_RADIAL_SEGMENTS = 4;
const REAR_FLOOR_HEIGHT = REAR_HEIGHT * 0.22; // thin flat floor/diffuser strip the cover sits on (secondary color)

// Side stripe (design 6.8.1, third follow-up): a thin accent-color line
// along the rear cover's flat side panel (user: "側面にラインを入れる").
// Height fraction is measured from the floor (0) to the spine (1); a
// low-ish stripe sits on the wider, more visible part of the panel.
const SIDE_STRIPE_HEIGHT_FRACTION = 0.35;
const SIDE_STRIPE_THICKNESS = 0.04;
const SIDE_STRIPE_MARGIN = 0.01; // clear of the panel surface to avoid z-fighting

// Shark fin along the spine, from behind the halo to the rear wing --
// another primitive-only sleekness cue, built the same tapered-cylinder way
// as the nose/cover but flattened *sideways* (scale.x) instead of
// vertically, so it stays tall (following the taper) while staying thin
// side-to-side.
const FIN_FRONT_HEIGHT = 0.32;
const FIN_REAR_HEIGHT = 0.12;
const FIN_THICKNESS_SCALE = 0.12; // fraction of height, sideways
const FIN_LENGTH = 1.3;
const FIN_Z = -1.55; // center, roughly halo-apex to rear-wing-strut span
const FIN_RADIAL_SEGMENTS = 8;
const FIN_BASE_Y_OVERLAP = 0.15; // sinks slightly into the cover mesh so its base isn't visibly floating above the tapered surface

const FRONT_WING_WIDTH = 0.9;
const FRONT_WING_DEPTH = 0.35;
const FRONT_WING_THICKNESS = 0.05;
const FRONT_WING_ENDPLATE_HEIGHT = 0.25;

const REAR_WING_WIDTH = 1.4;
const REAR_WING_DEPTH = 0.4;
const REAR_WING_THICKNESS = 0.06;
const REAR_WING_ENDPLATE_HEIGHT = 0.2;
const REAR_WING_STRUT_HEIGHT = 0.45; // rear-tub top -> wing underside
const REAR_WING_Z = -(REAR_LENGTH - REAR_WING_DEPTH / 2 - 0.1); // near the tail, small overhang

const SIDE_POD_WIDTH = 0.25;
const SIDE_POD_HEIGHT = 0.35;
const SIDE_POD_LENGTH = 1.6;
const SIDE_POD_X = REAR_WIDTH / 2 + SIDE_POD_WIDTH / 2;
const SIDE_POD_Z = -REAR_LENGTH / 2;

const MIRROR_STALK_HEIGHT = 0.15;
const MIRROR_X = REAR_WIDTH / 2 + 0.1;
const MIRROR_Y = 0.85;

// Halo (design 6.8.1, second follow-up): a single curved arch (a `TubeGeometry`
// swept along a Catmull-Rom curve through the two base points and the apex)
// instead of the original two straight struts -- the straight-strut version
// read as an unfinished wireframe triangle rather than the smooth arch a
// real halo is, part of the same "not sleek enough" feedback as the rear
// cover above. The apex sits behind the nose/front-wing (z < 0, same side
// as the tub), so it stays out of the cockpit camera's forward view
// frustum like the rest of the rear-side elements (see file header).
const HALO_BASE_Y = GROUND_CLEARANCE + REAR_HEIGHT;
const HALO_BASE_HALF_WIDTH = 0.28;
const HALO_BASE_Z = -0.9;
const HALO_APEX_Y = 1.3;
const HALO_APEX_Z = -0.1;
const HALO_TUBE_RADIUS = 0.035;
const HALO_TUBE_SEGMENTS = 16;

export const WHEEL_RADIUS = 0.33; // exported so main.ts can convert speed to a rolling angular rate (design 6.8.1)
const WHEEL_THICKNESS = 0.28;
const WHEEL_INSET_FROM_END = 0.5; // distance from the front/rear bumper to each axle
const RIM_RADIUS = WHEEL_RADIUS * 0.55;

const BODY_LENGTH = NOSE_LENGTH + REAR_LENGTH;

const BODY_COLOR = 0xd6182a;
const SECONDARY_COLOR = 0x1e2226; // two-tone panel (side pods, nose tip band) -- design 6.8.1
const ACCENT_COLOR = 0xf2f2f2; // livery stripe
const WING_COLOR = 0x1a1a1a; // wings/struts: dark, so they read against the red body from any angle
const WHEEL_COLOR = 0x1a1a1a;
const RIM_COLOR = 0x999999;

const NUMBER_DECAL_DIGITS = "5"; // generic number, not tied to any real team/driver (requirement 2.2)
const NUMBER_DECAL_Z_FRACTION = 0.35; // along the nose, base=0 / tip=1
const NUMBER_DECAL_MARGIN = 0.015; // clear of the nose surface to avoid z-fighting

/** Handles returned by {@link buildVehicleMesh} for the parts `main.ts` animates per frame (design 6.8.1). */
export interface VehicleMeshHandles {
  group: THREE.Group;
  /** [left, right] front wheels. Rotate `.rotation.y` to the current steer angle. */
  frontSteerPivots: [THREE.Group, THREE.Group];
  /** [frontLeft, frontRight, rearLeft, rearRight]. Rotate `.rotation.x` for the rolling animation. */
  wheelAxles: [THREE.Group, THREE.Group, THREE.Group, THREE.Group];
}

function box(
  material: THREE.Material,
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y, z);
  return mesh;
}

function buildWing(
  material: THREE.Material,
  width: number,
  depth: number,
  thickness: number,
  endplateHeight: number,
  y: number,
  z: number,
  endplateMaterial: THREE.Material = material,
): THREE.Group {
  const wing = new THREE.Group();
  wing.add(box(material, width, thickness, depth, 0, y, z));
  for (const x of [-width / 2, width / 2]) {
    wing.add(box(endplateMaterial, 0.05, endplateHeight, depth, x, y - endplateHeight / 2 + thickness / 2, z));
  }
  return wing;
}

/**
 * The halo as one smooth arch: a Catmull-Rom curve interpolating through
 * the left base, apex, and right base, swept into a tube. Passing the
 * curve directly through those three points (rather than deriving a torus
 * radius/rotation to hit the same targets) keeps this in terms of the same
 * base/apex coordinates the old straight-strut version used.
 */
function buildHalo(material: THREE.Material): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-HALO_BASE_HALF_WIDTH, HALO_BASE_Y, HALO_BASE_Z),
    new THREE.Vector3(0, HALO_APEX_Y, HALO_APEX_Z),
    new THREE.Vector3(HALO_BASE_HALF_WIDTH, HALO_BASE_Y, HALO_BASE_Z),
  ]);
  const geometry = new THREE.TubeGeometry(curve, HALO_TUBE_SEGMENTS, HALO_TUBE_RADIUS, 8, false);
  return new THREE.Mesh(geometry, material);
}

/**
 * Shark fin along the spine (design 6.8.1, second follow-up): a tapered,
 * flattened cylinder built the same way as the nose/rear cover, but this
 * time flattened *sideways* (scale.x) instead of vertically, so its height
 * follows the radius taper (tall near the halo, short near the wing) while
 * staying thin front-to-back... side-to-side.
 */
function buildFin(material: THREE.Material): THREE.Mesh {
  const fin = new THREE.Mesh(
    new THREE.CylinderGeometry(FIN_FRONT_HEIGHT, FIN_REAR_HEIGHT, FIN_LENGTH, FIN_RADIAL_SEGMENTS),
    material,
  );
  fin.rotation.x = Math.PI / 2;
  fin.scale.x = FIN_THICKNESS_SCALE;
  fin.position.set(0, GROUND_CLEARANCE + REAR_HEIGHT - FIN_BASE_Y_OVERLAP, FIN_Z);
  return fin;
}

function buildNumberDecal(x: number): THREE.Mesh {
  const radiusAtDecal = THREE.MathUtils.lerp(NOSE_BASE_RADIUS, NOSE_TIP_RADIUS, NUMBER_DECAL_Z_FRACTION);
  const texture = createNumberDecalTexture(NUMBER_DECAL_DIGITS);
  const material = new THREE.MeshStandardMaterial({ map: texture });
  const decal = new THREE.Mesh(new THREE.CircleGeometry(radiusAtDecal * NOSE_VERTICAL_SCALE * 0.8, 16), material);
  decal.position.set(x, GROUND_CLEARANCE + radiusAtDecal * NOSE_VERTICAL_SCALE, NOSE_LENGTH * NUMBER_DECAL_Z_FRACTION);
  decal.rotation.y = x > 0 ? Math.PI / 2 : -Math.PI / 2;
  decal.position.x += (radiusAtDecal + NUMBER_DECAL_MARGIN) * Math.sign(x);
  return decal;
}

/** One wheel's axle group (spins on `.rotation.x`), with the wheel + rim meshes inside it. */
function buildWheelAxle(wheelMaterial: THREE.Material, rimMaterial: THREE.Material): THREE.Group {
  const axle = new THREE.Group();
  const wheelGeometry = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, WHEEL_THICKNESS, 16);
  const rimGeometry = new THREE.CylinderGeometry(RIM_RADIUS, RIM_RADIUS, WHEEL_THICKNESS + 0.02, 12);

  const wheel = new THREE.Mesh(wheelGeometry, wheelMaterial);
  wheel.rotation.z = Math.PI / 2; // cylinder axis (default Y) -> axle axis (X)
  axle.add(wheel);

  const rim = new THREE.Mesh(rimGeometry, rimMaterial);
  rim.rotation.z = Math.PI / 2;
  axle.add(rim);

  return axle;
}

export function buildVehicleMesh(): VehicleMeshHandles {
  const group = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: BODY_COLOR });
  const secondaryMaterial = new THREE.MeshStandardMaterial({ color: SECONDARY_COLOR });
  const accentMaterial = new THREE.MeshStandardMaterial({ color: ACCENT_COLOR });
  const wingMaterial = new THREE.MeshStandardMaterial({ color: WING_COLOR });

  // Nose (+Z, ahead of the driver -- kept narrow, see file header): a
  // tapered cylinder (design 6.8.1) instead of a flat-fronted box, laid
  // along Z (rotation.x = 90 deg maps local +Y, the cylinder's `radiusTop`
  // end, to world +Z) and flattened vertically to keep the same top height
  // as before. A dark secondary-color band near the tip gives the two-tone
  // livery (design 6.8.1) instead of the old single-color nose.
  const nose = new THREE.Mesh(
    new THREE.CylinderGeometry(NOSE_TIP_RADIUS, NOSE_BASE_RADIUS, NOSE_LENGTH, NOSE_RADIAL_SEGMENTS),
    bodyMaterial,
  );
  nose.rotation.x = Math.PI / 2;
  // Flattens the vertical extent. After the 90deg X-rotation, local Y (the
  // cylinder's length axis) maps to world Z and local Z maps to world Y --
  // so scaling local *Z* is what flattens the visible height, not scale.y
  // (an earlier version of this scaled .y, which instead shortened the
  // nose's world-Z length and left the full circular radius as the visible
  // height, recreating exactly the "wall of forward view" problem the file
  // header warns about -- found by taking a cockpit-view screenshot).
  nose.scale.z = NOSE_VERTICAL_SCALE;
  nose.position.set(0, GROUND_CLEARANCE + NOSE_BASE_RADIUS * NOSE_VERTICAL_SCALE, NOSE_LENGTH / 2);
  group.add(nose);

  const noseTipBand = new THREE.Mesh(
    new THREE.CylinderGeometry(NOSE_TIP_RADIUS * 1.02, NOSE_TIP_RADIUS * 1.4, NOSE_LENGTH * 0.18, NOSE_RADIAL_SEGMENTS),
    secondaryMaterial,
  );
  noseTipBand.rotation.x = Math.PI / 2;
  noseTipBand.scale.z = NOSE_VERTICAL_SCALE; // see the nose mesh above for why .z, not .y
  noseTipBand.position.set(0, GROUND_CLEARANCE + NOSE_BASE_RADIUS * NOSE_VERTICAL_SCALE, NOSE_LENGTH * 0.91);
  group.add(noseTipBand);

  group.add(buildNumberDecal(-1), buildNumberDecal(1));

  // Front wing, mounted at the nose tip.
  group.add(
    buildWing(
      wingMaterial,
      FRONT_WING_WIDTH,
      FRONT_WING_DEPTH,
      FRONT_WING_THICKNESS,
      FRONT_WING_ENDPLATE_HEIGHT,
      GROUND_CLEARANCE + FRONT_WING_THICKNESS / 2,
      NOSE_LENGTH + FRONT_WING_DEPTH / 2,
    ),
  );

  // Rear/cockpit body (-Z, behind the eye -- see file header): a thin flat
  // floor/diffuser strip (secondary color) topped by a tapered, rounded
  // engine cover (body color) instead of a flat two-tone box (design 6.8.1,
  // second follow-up -- see the constants above for why).
  group.add(
    box(secondaryMaterial, REAR_WIDTH, REAR_FLOOR_HEIGHT, REAR_LENGTH, 0, GROUND_CLEARANCE + REAR_FLOOR_HEIGHT / 2, -REAR_LENGTH / 2),
  );
  const rearCoverHeight = REAR_HEIGHT - REAR_FLOOR_HEIGHT;
  // The 45deg face alignment (see the constants above) is baked into the
  // geometry itself via `thetaStart`, not a `mesh.rotation.y` -- an earlier
  // version rotated the mesh instead, which broke left-right symmetry: the
  // length stretch below (`scale.z`) is applied to the geometry's *local*
  // Z axis before any mesh rotation is applied (Three.js composes a mesh's
  // matrix as translate * rotate * scale), so with a 45deg mesh rotation
  // already in place, that scale ended up stretching along a diagonal
  // between world X and Z instead of straight down the car's centerline --
  // visibly asymmetric (found from the user noticing the rendered car
  // wasn't symmetric, then confirmed by working through the transform
  // order above). Setting `thetaStart` shifts the vertex angles during
  // geometry construction instead, so the mesh itself carries no rotation
  // and `scale.z` stays aligned with world Z as intended.
  const rearCover = new THREE.Mesh(
    new THREE.CylinderGeometry(
      REAR_COVER_TOP_RADIUS,
      REAR_COVER_BOTTOM_RADIUS,
      rearCoverHeight,
      REAR_COVER_RADIAL_SEGMENTS,
      1,
      false,
      Math.PI / 4,
    ),
    bodyMaterial,
  );
  rearCover.scale.z = (REAR_LENGTH / 2) / REAR_COVER_BOTTOM_RADIUS;
  rearCover.position.set(0, GROUND_CLEARANCE + REAR_FLOOR_HEIGHT + rearCoverHeight / 2, -REAR_LENGTH / 2);
  group.add(rearCover);

  // Side stripe on the cover's flat side panels (design 6.8.1, third
  // follow-up, user: "側面にラインを入れる"). The panel's flat distance from
  // the center (the apothem) is the circumscribed radius times cos(45deg)
  // for a square cross-section, not the radius itself.
  const stripeRadius = THREE.MathUtils.lerp(REAR_COVER_BOTTOM_RADIUS, REAR_COVER_TOP_RADIUS, SIDE_STRIPE_HEIGHT_FRACTION);
  const stripeX = stripeRadius * Math.cos(Math.PI / 4) + SIDE_STRIPE_MARGIN;
  const stripeY = GROUND_CLEARANCE + REAR_FLOOR_HEIGHT + SIDE_STRIPE_HEIGHT_FRACTION * rearCoverHeight;
  for (const x of [-stripeX, stripeX]) {
    group.add(box(accentMaterial, SIDE_STRIPE_THICKNESS, SIDE_STRIPE_THICKNESS, REAR_LENGTH * 0.85, x, stripeY, -REAR_LENGTH / 2));
  }

  // Side pods flanking the tub, in the secondary color for the two-tone livery (design 6.8.1).
  for (const x of [-SIDE_POD_X, SIDE_POD_X]) {
    group.add(box(secondaryMaterial, SIDE_POD_WIDTH, SIDE_POD_HEIGHT, SIDE_POD_LENGTH, x, GROUND_CLEARANCE + SIDE_POD_HEIGHT / 2, SIDE_POD_Z));
  }

  // Mirrors, at the front of the tub.
  for (const x of [-MIRROR_X, MIRROR_X]) {
    group.add(box(bodyMaterial, 0.03, MIRROR_STALK_HEIGHT, 0.03, x, MIRROR_Y - MIRROR_STALK_HEIGHT / 2, 0));
    group.add(box(bodyMaterial, 0.12, 0.08, 0.03, x, MIRROR_Y, 0));
  }

  // Halo over the cockpit (design 6.8.1). Uses the accent color (not the
  // dark wing color) so it reads clearly against the body from a chase-view
  // distance instead of blending into the similarly-dark rear wing/struts.
  group.add(buildHalo(accentMaterial));

  // Shark fin along the spine (design 6.8.1, second follow-up), same accent
  // color as the halo/endplates for a cohesive tri-tone livery.
  group.add(buildFin(accentMaterial));

  // Rear wing, on struts above the tail. Endplates use the accent color
  // (design 6.8.1 follow-up) so the two-tone livery has a visible accent
  // from directly behind, where the endplates face the chase camera
  // head-on (the main plane is seen edge-on and barely visible from there).
  const wingY = GROUND_CLEARANCE + REAR_HEIGHT + REAR_WING_STRUT_HEIGHT;
  for (const x of [-0.5, 0.5]) {
    group.add(
      box(wingMaterial, 0.06, REAR_WING_STRUT_HEIGHT, 0.06, x, GROUND_CLEARANCE + REAR_HEIGHT + REAR_WING_STRUT_HEIGHT / 2, REAR_WING_Z),
    );
  }
  group.add(
    buildWing(
      wingMaterial,
      REAR_WING_WIDTH,
      REAR_WING_DEPTH,
      REAR_WING_THICKNESS,
      REAR_WING_ENDPLATE_HEIGHT,
      wingY,
      REAR_WING_Z,
      accentMaterial,
    ),
  );

  // Wheels: each axle (spins on rotation.x, design 6.8.1) holds the wheel +
  // rim meshes; the front two axles additionally sit inside a steer pivot
  // (rotates on rotation.y) so the visible wheel turns with the steering
  // input. Axle position is set on the axle group itself so the steer
  // pivot's own origin can stay at the same point (rotating in place).
  const wheelMaterial = new THREE.MeshStandardMaterial({ color: WHEEL_COLOR });
  const rimMaterial = new THREE.MeshStandardMaterial({ color: RIM_COLOR });
  const xOffset = REAR_WIDTH / 2 + WHEEL_THICKNESS / 2;
  const zOffset = BODY_LENGTH / 2 - WHEEL_INSET_FROM_END;

  const rearAxles: THREE.Group[] = [];
  for (const x of [-xOffset, xOffset]) {
    const axle = buildWheelAxle(wheelMaterial, rimMaterial);
    axle.position.set(x, WHEEL_RADIUS, -zOffset);
    group.add(axle);
    rearAxles.push(axle);
  }

  const frontSteerPivots: THREE.Group[] = [];
  const frontAxles: THREE.Group[] = [];
  for (const x of [-xOffset, xOffset]) {
    const axle = buildWheelAxle(wheelMaterial, rimMaterial);
    const steerPivot = new THREE.Group();
    steerPivot.position.set(x, WHEEL_RADIUS, zOffset);
    steerPivot.add(axle);
    group.add(steerPivot);
    frontSteerPivots.push(steerPivot);
    frontAxles.push(axle);
  }

  return {
    group,
    frontSteerPivots: [frontSteerPivots[0], frontSteerPivots[1]],
    wheelAxles: [frontAxles[0], frontAxles[1], rearAxles[0], rearAxles[1]],
  };
}
