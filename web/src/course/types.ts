/**
 * Intermediate course-data format types.
 *
 * Design ref: 02_design.md section 5.1 (schema `gradient-circuit/course@2`).
 * This file is the JS/TS side of the layer contract between the Python
 * generator (tools/) and the simulator: it must stay a 1:1 mirror of the
 * JSON schema, with no Three.js or DOM types.
 */

export const COURSE_SCHEMA = "gradient-circuit/course@2" as const;
/** `@1` predates the `reference` block (P15) but is otherwise identical;
 * the loader still accepts it (design 5.1/P15.2) with referenceSpeed
 * falling back to Infinity. */
export const COURSE_SCHEMA_LEGACY_V1 = "gradient-circuit/course@1" as const;

export interface CourseMeta {
  name: string;
  event: string;
  year: number;
  session: string;
  source: string;
  generated_at: string;
  generator_version: string;
  laps_used: number;
  drivers_used: string[];
  /** FastF1 raw-unit-to-meter scale used when generating this course. */
  scale: number;
  /** "disabled" | "lateral-regression" -- see design 4.6. */
  bank_source: string;
  width_calibration: { k: number; margin: number };
}

export interface CourseSamples {
  /** Cumulative distance along the centerline [m], length = count. */
  s: number[];
  /** Centerline X [m], intermediate-format axes (Z up, right-handed). */
  x: number[];
  y: number[];
  z: number[];
  /** Half-width to the left of the centerline [m] (design: possibly asymmetric). */
  widthLeft: number[];
  /** Half-width to the right of the centerline [m]. */
  widthRight: number[];
  /** Signed curvature [1/m], left turn positive. */
  curvature: number[];
  /** Longitudinal grade [rad], uphill positive. */
  grade: number[];
  /** Bank/cant angle [rad]. All-zero when meta.bank_source === "disabled". */
  bank: number[];
}

/** Reference lap speed profile (design 4.8, requirement 3.6). Absent in
 * `@1` documents. */
export interface CourseReference {
  driver: string;
  lap_number: number;
  lap_time_s: number;
  /** Fraction of samples with a real (non-interpolated) telemetry point. */
  coverage: number;
  /** Reference speed [m/s] at each sample, length = count. */
  speed: number[];
}

/** Raw shape of course/*.json, exactly as written by tools/export.py. */
export interface CourseData {
  schema: string;
  meta: CourseMeta;
  reference?: CourseReference;
  units: { length: string; angle: string };
  axes: { up: string; handedness: string };
  closed: boolean;
  /** Total course length [m]. */
  length: number;
  /** Sample spacing [m]; samples are guaranteed uniform at this spacing (design 5.2 #3). */
  ds: number;
  /** Number of samples; every array in `samples` has exactly this length. */
  count: number;
  samples: CourseSamples;
}
