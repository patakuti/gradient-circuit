/**
 * Driver-eye camera: rigidly mounted to the car, looking down the car's
 * own nose.
 *
 * Design ref: 02_design.md section 6.6. Previously looked toward a fixed
 * point on the track ahead (`pose.lookahead`, for a corner-reading cue),
 * but that has the same motion-sickness problem chaseRig.ts's boom had
 * and was fixed for the same way (real play, P12 follow-up): the car
 * visually rotates under steering while the camera's own gaze stays
 * pinned to the road, mismatching where "forward" is expected to be.
 * Looks down `pose.forward` instead, like chaseRig.ts's boom.
 */

import * as THREE from "three";
import type { CameraRig, VehiclePose } from "./types";

const EYE_HEIGHT_M = 1.05;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

// Bank roll is flagged off by design (§4.6: bank is always 0 on the
// generated course anyway, so this has no visible effect today, but keeps
// the rig ready for a future non-zero bank source).
const ENABLE_BANK_ROLL = false;

export class CockpitRig implements CameraRig {
  readonly id = "cockpit";
  readonly label = "Cockpit";

  reset(): void {
    // Rigidly mounted -- no internal smoothing state to reset.
  }

  update(camera: THREE.PerspectiveCamera, pose: VehiclePose): void {
    const up = new THREE.Vector3(pose.up.x, pose.up.y, pose.up.z);
    const eye = new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z).addScaledVector(
      up,
      EYE_HEIGHT_M,
    );
    const forward = new THREE.Vector3(pose.forward.x, pose.forward.y, pose.forward.z);
    camera.position.copy(eye);
    camera.up.copy(ENABLE_BANK_ROLL ? up : WORLD_UP);
    camera.lookAt(eye.x + forward.x, eye.y + forward.y, eye.z + forward.z);
  }
}
