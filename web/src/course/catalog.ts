/**
 * Static list of courses available to select in the UI / via `?course=`.
 *
 * Design ref: 02_design.md section 6.9. Each `id` must match a
 * `CircuitConfig.id` on the Python side (tools/src/gradient_circuit/
 * circuits.py) and a `web/public/course/<id>.json` file. Kept as a static
 * list (not discovered dynamically) since course JSON is pre-generated and
 * committed, not produced at runtime.
 */

export type CourseKind = "street" | "circuit";

/**
 * A named section of a course, used by render/cityScenery.ts to place
 * course-specific scenery (design 6.12). Only Monaco (`kind: "street"`)
 * uses this so far.
 *
 * `sStart`/`sEnd` were derived by analyzing web/public/course/monaco.json's
 * actual elevation/curvature data against Monaco's well-known corner order
 * (design 6.12 has the full derivation and confidence notes) -- not
 * guessed, per the project's "no implementation from speculation" rule.
 * The exact meter boundaries carry medium confidence (they combine the
 * measured data with real-world knowledge of which stretch is physically
 * covered), so treat them as a starting point to refine visually.
 */
export interface CourseFeature {
  type: "tunnel" | "harbor";
  sStart: number; // [m]
  sEnd: number; // [m]
  side?: "left" | "right"; // harbor only: which side (sim/track.ts normal sign, left positive) is water
}

export interface CourseOption {
  id: string;
  label: string;
  kind: CourseKind;
  features?: CourseFeature[];
}

export const COURSE_CATALOG: CourseOption[] = [
  {
    id: "monaco",
    label: "Monaco",
    kind: "street",
    features: [
      { type: "tunnel", sStart: 1450, sEnd: 1760 },
      { type: "harbor", sStart: 1760, sEnd: 2900, side: "left" },
    ],
  },
  { id: "suzuka", label: "Suzuka", kind: "circuit" },
];

export const DEFAULT_COURSE_ID = "monaco";
