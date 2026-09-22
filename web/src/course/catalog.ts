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
 * A named section of a course. `tunnel`/`harbor` are used by
 * render/cityScenery.ts to place course-specific scenery (design 6.12);
 * `curb` (P27) is also read by sim/surface.ts to add a curb band in front
 * of the wall on courses that don't have one everywhere (design 6.13.5).
 * Only Monaco (`kind: "street"`) uses this so far.
 *
 * `sStart`/`sEnd` were derived by analyzing web/public/course/monaco.json's
 * actual elevation/curvature data against Monaco's well-known corner order
 * (design 6.12/6.13.5 have the full derivation and confidence notes) -- not
 * guessed, per the project's "no implementation from speculation" rule.
 * The exact meter boundaries carry medium confidence (they combine the
 * measured data with real-world knowledge of which stretch is physically
 * covered), so treat them as a starting point to refine visually. Which
 * corners have a curb at all (the `curb` entries below) is high confidence:
 * confirmed by the user against 2026 onboard footage (design 6.13.5).
 */
export interface CourseFeature {
  type: "tunnel" | "harbor" | "curb";
  sStart: number; // [m]
  sEnd: number; // [m]
  side?: "left" | "right"; // harbor: which side is water. curb: which side has the curb (omitted = both). sim/track.ts normal sign, left positive
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
      // Curb corners (design 6.13.5, P27): confirmed against 2026 onboard
      // footage. Corners with no curb in reality (Massenet, Casino Square,
      // Mirabeau Haute, Tabac, the second/back Swimming Pool esses, La
      // Rascasse) intentionally have no entry -- the wall stays right at
      // the paved edge there, per requirement 4.7.3.
      //
      // `sEnd` below is the curvature analysis's own corner-end estimate
      // (design 6.13.5) plus a flat +25m (design 6.13.5 follow-up, P27):
      // drivers ride a curb into the corner exit, past the geometric
      // apex, more than on entry, and the first version's zones stopped
      // too early there (user report: "カーブの立ち上がりの縁石を伸ばし
      // て...外側の縁石にのりあげることがある"). Baked directly into
      // `sEnd` (not a separate offset applied elsewhere) so the visible
      // curb ribbon (render/cityScenery.ts) and the physics zone
      // (sim/surface.ts) read the same number and can't drift apart
      // (design 6.12's rule). `sStart` is untouched -- the report was
      // about exits, not entries. A tuning value, pending real-play
      // confirmation; on a couple of corners the extension overlaps the
      // next corner's own curb zone, which is harmless (both are curb).
      { type: "curb", sStart: 175, sEnd: 239 }, // Sainte Devote (214 + 25)
      { type: "curb", sStart: 1184, sEnd: 1276 }, // Grand Hotel Hairpin (Fairmont) (1251 + 25)
      { type: "curb", sStart: 1265, sEnd: 1344 }, // Mirabeau Bas (1319 + 25)
      { type: "curb", sStart: 1351, sEnd: 1433 }, // Portier (1408 + 25)
      { type: "curb", sStart: 2023, sEnd: 2140, side: "right" }, // Nouvelle Chicane -- right side only (2115 + 25)
      { type: "curb", sStart: 2451, sEnd: 2540 }, // Swimming Pool (first S; the second S has no curb) (2515 + 25)
      { type: "curb", sStart: 2922, sEnd: 3020 }, // Anthony Noghes (2995 + 25)
    ],
  },
  { id: "suzuka", label: "Suzuka", kind: "circuit" },
];

export const DEFAULT_COURSE_ID = "monaco";
