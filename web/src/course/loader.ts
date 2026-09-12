/**
 * Course data loading: fetch, validate invariants, and convert axes.
 *
 * Design ref: 02_design.md sections 3 (coordinate systems) and 5.2
 * (invariants the loader must verify). Depends only on `course/types` --
 * no `three` import (see design 6.1's dependency table and the note under
 * section 3 on why sim/track.ts can safely consume this module's output).
 */

import type { CourseData, CourseMeta, CourseReference } from "./types";
import { COURSE_SCHEMA, COURSE_SCHEMA_LEGACY_V1 } from "./types";
import type { Vec3 } from "../sim/vec";
import { vec3 } from "../sim/vec";

export class CourseLoadError extends Error {}

/** One sample of the loaded, validated, Three.js-axis-converted course. */
export interface CourseSample {
  s: number;
  position: Vec3; // Three.js axes (Y up), see toThreeAxes()
  widthLeft: number;
  widthRight: number;
  curvature: number;
  grade: number;
  bank: number;
  /** Reference lap speed [m/s] at this sample (design 4.8/6.14.3, P15).
   * `Infinity` when the course has no `reference` block (`@1`, design 5.1
   * backward compat) -- the autopilot's min() then falls through to the
   * grip-limited speed unchanged. */
  referenceSpeed: number;
}

/** Runtime-ready course: validated, axis-converted, easy to index. */
export interface Course {
  meta: CourseMeta;
  reference?: CourseReference;
  closed: boolean;
  length: number;
  ds: number;
  count: number;
  samples: CourseSample[];
}

/**
 * Intermediate-format (Z up, right-handed) -> Three.js (Y up, right-handed).
 * (x, y, z) -> (x, z, -y). A -90 deg rotation about X (det +1): no mirroring,
 * so left/right corner direction is preserved. Design ref: section 3.
 */
export function toThreeAxes(x: number, y: number, z: number): Vec3 {
  return vec3(x, z, -y);
}

const VALID_SCHEMAS: ReadonlySet<string> = new Set([COURSE_SCHEMA, COURSE_SCHEMA_LEGACY_V1]);
const SPACING_TOLERANCE = 0.01; // design 5.2 invariant #3: within +-1%
// design 5.2 invariant #8: a plausible reference-speed range. 10 m/s
// (36 km/h) floors out pit-lane-speed artifacts; 120 m/s (432 km/h) is
// comfortably above any F1 top speed ever recorded.
const REFERENCE_SPEED_MIN = 10;
const REFERENCE_SPEED_MAX = 120;

/** Validate the invariants from design 5.2. Throws CourseLoadError on violation. */
function validate(doc: CourseData): void {
  if (!VALID_SCHEMAS.has(doc.schema)) {
    throw new CourseLoadError(`Unknown course schema: ${doc.schema}`);
  }

  const { s, x, y, z, widthLeft, widthRight, curvature, grade, bank } = doc.samples;
  const arrays: [string, number[]][] = [
    ["s", s], ["x", x], ["y", y], ["z", z],
    ["widthLeft", widthLeft], ["widthRight", widthRight],
    ["curvature", curvature], ["grade", grade], ["bank", bank],
  ];
  for (const [name, arr] of arrays) {
    if (arr.length !== doc.count) {
      throw new CourseLoadError(
        `samples.${name} has length ${arr.length}, expected count=${doc.count}`,
      );
    }
  }

  for (const [name, arr] of arrays) {
    for (const v of arr) {
      if (!Number.isFinite(v)) {
        throw new CourseLoadError(`samples.${name} contains a non-finite value (NaN/Inf)`);
      }
    }
  }

  for (let i = 0; i < s.length - 1; i++) {
    const spacing = s[i + 1] - s[i];
    const deviation = Math.abs(spacing - doc.ds) / doc.ds;
    if (deviation > SPACING_TOLERANCE) {
      throw new CourseLoadError(
        `Non-uniform sample spacing at index ${i}: ${spacing.toFixed(4)}m ` +
          `(expected ${doc.ds}m +-${SPACING_TOLERANCE * 100}%)`,
      );
    }
  }

  if (doc.closed) {
    const dx = x[0] - x[x.length - 1];
    const dy = y[0] - y[y.length - 1];
    const dz = z[0] - z[z.length - 1];
    const gap = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (gap >= doc.ds) {
      throw new CourseLoadError(
        `Loop does not close: gap=${gap.toFixed(3)}m (expected < ds=${doc.ds}m)`,
      );
    }
  }

  for (let i = 0; i < widthLeft.length; i++) {
    if (widthLeft[i] <= 0 || widthRight[i] <= 0) {
      throw new CourseLoadError(`Non-positive width at index ${i}`);
    }
  }

  if (doc.reference) {
    const speed = doc.reference.speed;
    if (speed.length !== doc.count) {
      throw new CourseLoadError(
        `reference.speed has length ${speed.length}, expected count=${doc.count}`,
      );
    }
    for (let i = 0; i < speed.length; i++) {
      const v = speed[i];
      if (!Number.isFinite(v) || v <= 0) {
        throw new CourseLoadError(`reference.speed contains a non-finite/non-positive value at index ${i}`);
      }
      if (v < REFERENCE_SPEED_MIN || v > REFERENCE_SPEED_MAX) {
        throw new CourseLoadError(
          `reference.speed[${i}]=${v} outside plausible range [${REFERENCE_SPEED_MIN}, ${REFERENCE_SPEED_MAX}] m/s`,
        );
      }
    }
  }
}

/** Parse and validate a CourseData object already in memory (e.g. for tests). */
export function parseCourse(doc: CourseData): Course {
  validate(doc);
  const { s, x, y, z, widthLeft, widthRight, curvature, grade, bank } = doc.samples;
  const referenceSpeed = doc.reference?.speed;
  const samples: CourseSample[] = new Array(doc.count);
  for (let i = 0; i < doc.count; i++) {
    samples[i] = {
      s: s[i],
      position: toThreeAxes(x[i], y[i], z[i]),
      widthLeft: widthLeft[i],
      widthRight: widthRight[i],
      curvature: curvature[i],
      grade: grade[i],
      bank: bank[i],
      referenceSpeed: referenceSpeed ? referenceSpeed[i] : Infinity,
    };
  }
  return {
    meta: doc.meta,
    reference: doc.reference,
    closed: doc.closed,
    length: doc.length,
    ds: doc.ds,
    count: doc.count,
    samples,
  };
}

/** Fetch a course JSON file and return the validated, axis-converted course. */
export async function loadCourse(url: string): Promise<Course> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new CourseLoadError(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const doc = (await res.json()) as CourseData;
  return parseCourse(doc);
}
