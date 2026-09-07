/**
 * Course data loading: fetch, validate invariants, and convert axes.
 *
 * Design ref: 02_design.md sections 3 (coordinate systems) and 5.2
 * (invariants the loader must verify). Depends only on `course/types` --
 * no `three` import (see design 6.1's dependency table and the note under
 * section 3 on why sim/track.ts can safely consume this module's output).
 */

import type { CourseData, CourseMeta } from "./types";
import { COURSE_SCHEMA } from "./types";
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
}

/** Runtime-ready course: validated, axis-converted, easy to index. */
export interface Course {
  meta: CourseMeta;
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

const VALID_SCHEMAS: ReadonlySet<string> = new Set([COURSE_SCHEMA]);
const SPACING_TOLERANCE = 0.01; // design 5.2 invariant #3: within +-1%

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
}

/** Parse and validate a CourseData object already in memory (e.g. for tests). */
export function parseCourse(doc: CourseData): Course {
  validate(doc);
  const { s, x, y, z, widthLeft, widthRight, curvature, grade, bank } = doc.samples;
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
    };
  }
  return {
    meta: doc.meta,
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
