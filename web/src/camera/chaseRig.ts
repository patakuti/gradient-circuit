/**
 * Third-person chase camera: rigidly holds a fixed offset behind and above
 * the car.
 *
 * Design ref: 02_design.md section 6.6. Previously used exponential
 * position smoothing, but that produces a following distance proportional
 * to speed (a first-order lag's steady-state offset is roughly v/k for a
 * target moving at speed v) -- reported as an unwanted effect (P10), so the
 * position is now set directly each frame instead.
 *
 * P12 boom direction: briefly changed to boom off the track's own tangent
 * (not the car's yawed heading) to avoid the camera swinging on every
 * steering correction -- reverted after real play surfaced this as motion
 * sickness. The car visually rotating while the camera's own heading stays
 * fixed on the track mismatches vestibular expectation ("forward" is where
 * the car's nose points, not where the road points); real chase/onboard
 * cameras are rigged to the chassis for the same reason. The boom uses the
 * car's own forward again.
 */

import * as THREE from "three";
import type { CameraRig, VehiclePose } from "./types";

const BACK_M = 7.5;
const UP_M = 2.8;

function targetFor(pose: VehiclePose): THREE.Vector3 {
  const position = new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z);
  const forward = new THREE.Vector3(pose.forward.x, pose.forward.y, pose.forward.z);
  const up = new THREE.Vector3(pose.up.x, pose.up.y, pose.up.z);
  return position.addScaledVector(forward, -BACK_M).addScaledVector(up, UP_M);
}

export class ChaseRig implements CameraRig {
  readonly id = "chase";
  readonly label = "Chase";

  reset(): void {
    // Rigidly offset -- no smoothing state to reset.
  }

  update(camera: THREE.PerspectiveCamera, pose: VehiclePose): void {
    camera.position.copy(targetFor(pose));
    camera.up.set(pose.up.x, pose.up.y, pose.up.z);
    camera.lookAt(pose.position.x, pose.position.y, pose.position.z);
  }
}
