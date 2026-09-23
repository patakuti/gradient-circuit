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
 * `noBuilding` (P30) is also read by render/cityScenery.ts to suppress
 * building placement on one side, independent of `tunnel`/`harbor`.
 * `embankment` (P30 third follow-up) is read by render/embankment.ts to
 * fill down to a fixed elevation (`floorY`) instead of the auto-detected
 * crossover-zone floor or the course's default (no embankment at all,
 * since that follow-up) -- see that file's doc comment.
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
 *
 * `sStart > sEnd` (the `noBuilding`/`embankment` entries below) means the
 * range wraps past the loop's s=0 seam instead of being an ordinary
 * sStart-to-sEnd span (design 6.12.3, P30).
 */
export interface CourseFeature {
  type: "tunnel" | "harbor" | "curb" | "noBuilding" | "embankment";
  sStart: number; // [m]
  sEnd: number; // [m]
  side?: "left" | "right"; // harbor: which side is water. curb: which side has the curb. noBuilding/embankment: which side it applies to (all omitted = both). sim/track.ts normal sign, left positive
  floorY?: number; // [m] embankment only (required for that type): the fixed elevation to fill down to, in the same world-Y units as a sample's own position.y
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
      // No buildings on the course's right side from Anthony Noghes
      // (T18/19) through to Massenet (T3) -- start/finish straight, Sainte
      // Devote, and the Beau Rivage climb (design 6.12.3, P30, direct user
      // request). sStart > sEnd: wraps past the loop's s=0 seam. Corner
      // boundaries reused from the §6.13.5 table above (2922, 486); which
      // real-world side "right" lands on isn't verified, per that section's
      // notes -- this implements the user's literal side specification.
      { type: "noBuilding", sStart: 2922, sEnd: 486, side: "right" },
      // Embankment (法面) zones (design 6.7.1, P30 third follow-up): with
      // the terrain heightfield (P29) now backing the rest of the course,
      // the plain per-sample cliff-to-groundY embankment is only kept for
      // two specific, real-feature-motivated stretches; everywhere else on
      // Monaco has none (render/embankment.ts only builds what's declared
      // here or auto-detected as a crossover, neither of which applies to
      // the rest of the course). Direct user request.
      //
      // Right side, Anthony Noghes (T18/19) through Massenet (T3) -- same
      // arc as the `noBuilding` entry above (reused, not re-derived).
      // Floor: 47.6m, the lowest recorded elevation across the harbor
      // stretch (s=1760-2900, measured range 47.6-54.3m) -- a stand-in for
      // sea level, since the harbor's own promenade isn't perfectly flat.
      { type: "embankment", sStart: 2922, sEnd: 486, side: "right", floorY: 47.6 },
      // Left side, the climb up to the Grand Hotel Hairpin (Fairmont):
      // from Mirabeau Haute's end (1126) to the hairpin's own curb-zone
      // start (1184, both reused from existing boundaries above). Floor:
      // 61.1m, the elevation at the hairpin's own curb-zone end (1276) --
      // "the height after the hairpin", per the user's own framing. This
      // also replaces the auto-detected crossover zone that used to
      // (incidentally) shorten the cliff in part of this same stretch
      // (03_plan.md P28 sixth follow-up's "副作用の確認") --
      // render/embankment.ts suppresses that heuristic wherever an
      // explicit `embankment` entry already covers the range, so the two
      // don't draw overlapping ribbons.
      { type: "embankment", sStart: 1126, sEnd: 1184, side: "left", floorY: 61.1 },
    ],
  },
  { id: "suzuka", label: "Suzuka", kind: "circuit" },
];

export const DEFAULT_COURSE_ID = "monaco";
