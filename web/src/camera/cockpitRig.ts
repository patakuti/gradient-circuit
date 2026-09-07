/**
 * Driver-eye camera: rigidly mounted to the car, looking down the track's
 * lookahead point for a corner read.
 *
 * Design ref: 02_design.md section 6.6.
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
    camera.position.copy(eye);
    camera.up.copy(ENABLE_BANK_ROLL ? up : WORLD_UP);
    camera.lookAt(pose.lookahead.x, pose.lookahead.y, pose.lookahead.z);
  }
}
