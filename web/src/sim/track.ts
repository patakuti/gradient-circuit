/**
 * Track query: distance -> position/orientation/width/geometry.
 *
 * Design ref: 02_design.md section 6.2. No `three` import (enforced by
 * eslint.config.js) -- everything here uses sim/vec.ts's own Vec3 so this
 * module ports to another engine unchanged.
 */

import type { Course } from "../course/loader";
import type { Vec3 } from "./vec";
import { vec3, add, sub, scale, cross, normalize, lerp, rotateAroundAxis } from "./vec";

export interface TrackSample {
  s: number;
  position: Vec3;
  tangent: Vec3;
  normal: Vec3;
  up: Vec3;
  widthLeft: number;
  widthRight: number;
  curvature: number;
  grade: number;
  bank: number;
}

const WORLD_UP: Vec3 = vec3(0, 1, 0);

function lerpAngleField(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class Track {
  readonly length: number;
  readonly count: number;
  readonly ds: number;

  private readonly position: Vec3[];
  private readonly tangent: Vec3[];
  private readonly normal: Vec3[];
  private readonly up: Vec3[];
  private readonly widthLeft: Float64Array;
  private readonly widthRight: Float64Array;
  private readonly curvature: Float64Array;
  private readonly grade: Float64Array;
  private readonly bank: Float64Array;

  private constructor(course: Course) {
    this.length = course.length;
    this.count = course.count;
    this.ds = course.ds;

    const n = course.count;
    this.position = new Array(n);
    this.widthLeft = new Float64Array(n);
    this.widthRight = new Float64Array(n);
    this.curvature = new Float64Array(n);
    this.grade = new Float64Array(n);
    this.bank = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      const sample = course.samples[i];
      this.position[i] = sample.position;
      this.widthLeft[i] = sample.widthLeft;
      this.widthRight[i] = sample.widthRight;
      this.curvature[i] = sample.curvature;
      this.grade[i] = sample.grade;
      this.bank[i] = sample.bank;
    }

    // tangent: central difference over neighboring samples, periodic wrap.
    this.tangent = new Array(n);
    this.normal = new Array(n);
    this.up = new Array(n);
    for (let i = 0; i < n; i++) {
      const prev = this.position[(i - 1 + n) % n];
      const next = this.position[(i + 1) % n];
      const t = normalize(sub(next, prev));
      this.tangent[i] = t;
      // design 6.2: normal = normalize(cross(worldUp, tangent))
      const nrm = normalize(cross(WORLD_UP, t));
      this.normal[i] = nrm;
      // design 6.2: up = normalize(cross(tangent, normal)), rolled by bank.
      const upBase = normalize(cross(t, nrm));
      this.up[i] = this.bank[i] === 0 ? upBase : rotateAroundAxis(upBase, t, this.bank[i]);
    }
  }

  static from(course: Course): Track {
    return new Track(course);
  }

  /** Wrap s into [0, length). */
  private wrap(s: number): number {
    const L = this.length;
    let r = s % L;
    if (r < 0) r += L;
    return r;
  }

  /** Index/fraction of s along the sample grid, after wrapping. */
  private indexAt(s: number): { i: number; t: number } {
    const wrapped = this.wrap(s);
    const raw = wrapped / this.ds;
    const i = Math.floor(raw);
    const t = raw - i;
    return { i: i % this.count, t };
  }

  sampleAt(s: number): TrackSample {
    const { i, t } = this.indexAt(s);
    const j = (i + 1) % this.count;

    const position = lerp(this.position[i], this.position[j], t);
    const tangent = normalize(lerp(this.tangent[i], this.tangent[j], t));
    const normal = normalize(lerp(this.normal[i], this.normal[j], t));
    const up = normalize(lerp(this.up[i], this.up[j], t));

    return {
      s: this.wrap(s),
      position,
      tangent,
      normal,
      up,
      widthLeft: lerpAngleField(this.widthLeft[i], this.widthLeft[j], t),
      widthRight: lerpAngleField(this.widthRight[i], this.widthRight[j], t),
      curvature: lerpAngleField(this.curvature[i], this.curvature[j], t),
      grade: lerpAngleField(this.grade[i], this.grade[j], t),
      bank: lerpAngleField(this.bank[i], this.bank[j], t),
    };
  }

  /** Position offset laterally from the centerline by `lateralOffset` [m]
   * (positive = left, per the normal's sign convention). Reserved for
   * future steering (design 6.2 / 03_plan.md future-extension table). */
  positionAt(s: number, lateralOffset: number): Vec3 {
    const sample = this.sampleAt(s);
    return add(sample.position, scale(sample.normal, lateralOffset));
  }
}
