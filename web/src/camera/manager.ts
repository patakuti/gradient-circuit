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

  /** Registered rigs as plain {id, label} pairs, for e.g. a UI select control. */
  list(): { id: string; label: string }[] {
    return this.rigs.map((rig) => ({ id: rig.id, label: rig.label }));
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

  /** Explicitly select a rig by id, e.g. from a UI control. No-op if already active or unknown. */
  select(id: string): void {
    const idx = this.rigs.findIndex((rig) => rig.id === id);
    if (idx === -1 || idx === this.index || !this.lastPose) return;
    this.index = idx;
    this.current.reset(this.lastPose);
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== CYCLE_KEY || !this.lastPose) return;
    this.index = (this.index + 1) % this.rigs.length;
    this.current.reset(this.lastPose);
  };
}
