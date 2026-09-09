/**
 * Static list of courses available to select in the UI / via `?course=`.
 *
 * Design ref: 02_design.md section 6.9. Each `id` must match a
 * `CircuitConfig.id` on the Python side (tools/src/gradient_circuit/
 * circuits.py) and a `web/public/course/<id>.json` file. Kept as a static
 * list (not discovered dynamically) since course JSON is pre-generated and
 * committed, not produced at runtime.
 */

export interface CourseOption {
  id: string;
  label: string;
}

export const COURSE_CATALOG: CourseOption[] = [
  { id: "monaco", label: "Monaco" },
  { id: "suzuka", label: "Suzuka" },
];

export const DEFAULT_COURSE_ID = "monaco";
