/**
 * Holds registered camera rigs in order and cycles between them on the `C`
 * key. Adding a viewpoint is registering one more rig here -- no other
 * switching/input code changes.
 *
 * Design ref: 02_design.md section 6.6.
 */

import type { PerspectiveCamera } from "three";
import type { CameraRig, VehiclePose } from "./types";

const CYCLE_KEY = "KeyC";

export class CameraManager {
  private readonly rigs: CameraRig[];
  private index = 0;
  private lastPose: VehiclePose | null = null;

  constructor(rigs: CameraRig[]) {
    if (rigs.length === 0) throw new Error("CameraManager requires at least one rig");
    this.rigs = rigs;
    window.addEventListener("keydown", this.handleKeyDown);
  }

  get current(): CameraRig {
    return this.rigs[this.index];
  }

  /** Positions the camera for the first time, before the render loop starts. */
  init(camera: PerspectiveCamera, pose: VehiclePose): void {
    this.lastPose = pose;
    this.current.reset(pose);
    this.current.update(camera, pose, 0);
  }

  update(camera: PerspectiveCamera, pose: VehiclePose, dt: number): void {
    this.lastPose = pose;
    this.current.update(camera, pose, dt);
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== CYCLE_KEY || !this.lastPose) return;
    this.index = (this.index + 1) % this.rigs.length;
    this.current.reset(this.lastPose);
  };
}
