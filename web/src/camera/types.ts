/**
 * Camera rig contracts.
 *
 * Design ref: 02_design.md section 6.6. `camera/*` depends on `three` and
 * this file only -- it never reaches into `sim/track` directly. Anything a
 * rig needs about the vehicle's situation on track is precomputed by
 * main.ts into `VehiclePose` each frame.
 */

import type { PerspectiveCamera } from "three";
import type { Vec3 } from "../sim/vec";

export interface VehiclePose {
  position: Vec3; // track.positionAt(s, lateralOffset) -- includes the lateral offset (design 6.6, P12)
  forward: Vec3; // the car body's facing direction: the track tangent rotated by yaw (design 6.3.1)
  up: Vec3;
  right: Vec3;
  speed: number;
  s: number;
  lap: number;
}

export interface CameraRig {
  readonly id: string;
  readonly label: string;
  /** Reinitialize any internal smoothing state so the next update() doesn't sweep in from a stale position. */
  reset(pose: VehiclePose): void;
  update(camera: PerspectiveCamera, pose: VehiclePose, dt: number): void;
}
