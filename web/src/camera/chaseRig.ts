/**
 * Third-person chase camera: rigidly holds a fixed offset behind and above
 * the car.
 *
 * Design ref: 02_design.md section 6.6. Previously used exponential
 * position smoothing, but that produces a following distance proportional
 * to speed (a first-order lag's steady-state offset is roughly v/k for a
 * target moving at speed v) -- reported as an unwanted effect (P10), so the
 * position is now set directly each frame instead.
 */

import * as THREE from "three";
import type { CameraRig, VehiclePose } from "./types";

const BACK_M = 7.5;
const UP_M = 2.8;

function targetFor(pose: VehiclePose): THREE.Vector3 {
  const position = new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z);
  // The boom uses the track's own direction, not the car body's yawed
  // heading (design 6.6, P12): with steering, `forward` can swing up to
  // maxYaw off the track's line, and a boom anchored to it would swing the
  // camera around on every correction -- like a real chase/onboard camera
  // rigged to the course, not the chassis.
  const trackForward = new THREE.Vector3(pose.trackForward.x, pose.trackForward.y, pose.trackForward.z);
  const up = new THREE.Vector3(pose.up.x, pose.up.y, pose.up.z);
  return position.addScaledVector(trackForward, -BACK_M).addScaledVector(up, UP_M);
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
