/**
 * Procedurally generated vehicle body: an open-wheeler-style silhouette
 * (nose + front wing, cockpit/engine-cover tub with side pods, rear wing on
 * struts, four wheels with a rim accent). No external 3D model files (same
 * "no external assets" policy as render/textures.ts and audio/engine.ts).
 *
 * Design ref: 02_design.md section 6.8. Shown from both the chase and
 * cockpit cameras. Unlike `Camera.lookAt` (-Z at the target), a plain
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
 * wing), so it can be taller/wider without that problem.
 */

import * as THREE from "three";

const GROUND_CLEARANCE = 0.25; // ride height shared by the whole body

const NOSE_LENGTH = 1.8;
const NOSE_WIDTH = 0.5; // narrow so it doesn't wall off the cockpit's forward view
const NOSE_HEIGHT = 0.3; // top = 0.55 m, well clear of cockpitRig's 1.05 m eye height

const REAR_LENGTH = 2.4;
const REAR_WIDTH = 1.6;
const REAR_HEIGHT = 0.55; // top = 0.8 m; behind the eye point, out of the forward view

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

const WHEEL_RADIUS = 0.33;
const WHEEL_THICKNESS = 0.28;
const WHEEL_INSET_FROM_END = 0.5; // distance from the front/rear bumper to each axle
const RIM_RADIUS = WHEEL_RADIUS * 0.55;

const BODY_LENGTH = NOSE_LENGTH + REAR_LENGTH;

const BODY_COLOR = 0xd6182a;
const ACCENT_COLOR = 0xf2f2f2; // livery stripe
const WING_COLOR = 0x1a1a1a; // wings/struts: dark, so they read against the red body from any angle
const WHEEL_COLOR = 0x1a1a1a;
const RIM_COLOR = 0x999999;

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
): THREE.Group {
  const wing = new THREE.Group();
  wing.add(box(material, width, thickness, depth, 0, y, z));
  for (const x of [-width / 2, width / 2]) {
    wing.add(box(material, 0.05, endplateHeight, depth, x, y - endplateHeight / 2 + thickness / 2, z));
  }
  return wing;
}

export function buildVehicleMesh(): THREE.Group {
  const group = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: BODY_COLOR });
  const accentMaterial = new THREE.MeshStandardMaterial({ color: ACCENT_COLOR });
  const wingMaterial = new THREE.MeshStandardMaterial({ color: WING_COLOR });

  // Nose (+Z, ahead of the driver -- kept narrow, see file header) and its livery stripe.
  group.add(box(bodyMaterial, NOSE_WIDTH, NOSE_HEIGHT, NOSE_LENGTH, 0, GROUND_CLEARANCE + NOSE_HEIGHT / 2, NOSE_LENGTH / 2));
  group.add(
    box(accentMaterial, NOSE_WIDTH * 0.4, 0.02, NOSE_LENGTH, 0, GROUND_CLEARANCE + NOSE_HEIGHT + 0.01, NOSE_LENGTH / 2),
  );

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

  // Rear/cockpit tub (-Z, behind the eye -- see file header) and its livery stripe.
  group.add(box(bodyMaterial, REAR_WIDTH, REAR_HEIGHT, REAR_LENGTH, 0, GROUND_CLEARANCE + REAR_HEIGHT / 2, -REAR_LENGTH / 2));
  group.add(
    box(accentMaterial, REAR_WIDTH * 0.3, 0.02, REAR_LENGTH, 0, GROUND_CLEARANCE + REAR_HEIGHT + 0.01, -REAR_LENGTH / 2),
  );

  // Side pods flanking the tub.
  for (const x of [-SIDE_POD_X, SIDE_POD_X]) {
    group.add(box(bodyMaterial, SIDE_POD_WIDTH, SIDE_POD_HEIGHT, SIDE_POD_LENGTH, x, GROUND_CLEARANCE + SIDE_POD_HEIGHT / 2, SIDE_POD_Z));
  }

  // Mirrors, at the front of the tub.
  for (const x of [-MIRROR_X, MIRROR_X]) {
    group.add(box(bodyMaterial, 0.03, MIRROR_STALK_HEIGHT, 0.03, x, MIRROR_Y - MIRROR_STALK_HEIGHT / 2, 0));
    group.add(box(bodyMaterial, 0.12, 0.08, 0.03, x, MIRROR_Y, 0));
  }

  // Rear wing, on struts above the tail.
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
    ),
  );

  // Wheels with a lighter rim accent.
  const wheelMaterial = new THREE.MeshStandardMaterial({ color: WHEEL_COLOR });
  const rimMaterial = new THREE.MeshStandardMaterial({ color: RIM_COLOR });
  const wheelGeometry = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, WHEEL_THICKNESS, 16);
  const rimGeometry = new THREE.CylinderGeometry(RIM_RADIUS, RIM_RADIUS, WHEEL_THICKNESS + 0.02, 12);
  const xOffset = REAR_WIDTH / 2 + WHEEL_THICKNESS / 2;
  const zOffset = BODY_LENGTH / 2 - WHEEL_INSET_FROM_END;
  for (const x of [-xOffset, xOffset]) {
    for (const z of [-zOffset, zOffset]) {
      const wheel = new THREE.Mesh(wheelGeometry, wheelMaterial);
      wheel.rotation.z = Math.PI / 2; // cylinder axis (default Y) -> axle axis (X)
      wheel.position.set(x, WHEEL_RADIUS, z);
      group.add(wheel);

      const rim = new THREE.Mesh(rimGeometry, rimMaterial);
      rim.rotation.z = Math.PI / 2;
      rim.position.set(x, WHEEL_RADIUS, z);
      group.add(rim);
    }
  }

  return group;
}
