/**
 * Third-person chase camera: hovers behind and above the car, exponentially
 * smoothed so it doesn't rigidly track every bump.
 *
 * Design ref: 02_design.md section 6.6.
 */

import * as THREE from "three";
import type { CameraRig, VehiclePose } from "./types";

const BACK_M = 7.5;
const UP_M = 2.8;
const SMOOTH_K = 6.0; // exponential smoothing rate, alpha = 1 - exp(-k * dt)

function targetFor(pose: VehiclePose): THREE.Vector3 {
  const position = new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z);
  const forward = new THREE.Vector3(pose.forward.x, pose.forward.y, pose.forward.z);
  const up = new THREE.Vector3(pose.up.x, pose.up.y, pose.up.z);
  return position.addScaledVector(forward, -BACK_M).addScaledVector(up, UP_M);
}

export class ChaseRig implements CameraRig {
  readonly id = "chase";
  readonly label = "Chase";

  private smoothed: THREE.Vector3 | null = null;

  reset(pose: VehiclePose): void {
    this.smoothed = targetFor(pose);
  }

  update(camera: THREE.PerspectiveCamera, pose: VehiclePose, dt: number): void {
    const target = targetFor(pose);
    if (!this.smoothed) this.smoothed = target;
    const alpha = 1 - Math.exp(-SMOOTH_K * dt);
    this.smoothed.lerp(target, alpha);

    camera.position.copy(this.smoothed);
    camera.up.set(pose.up.x, pose.up.y, pose.up.z);
    camera.lookAt(pose.position.x, pose.position.y, pose.position.z);
  }
}
