// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Design ref: 02_design.md section 6.1 / acceptance criterion #11:
 * `sim/track.ts` and `sim/vehicle.ts` (and everything else under `sim/`)
 * must not import "three", to keep the simulation layer engine-agnostic.
 */
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**"],
  },
  {
    files: ["src/sim/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "three",
              message: "sim/ must stay engine-agnostic (design 6.1) -- no `three` imports here.",
            },
          ],
          patterns: [
            {
              group: ["three/*"],
              message: "sim/ must stay engine-agnostic (design 6.1) -- no `three` imports here.",
            },
          ],
        },
      ],
    },
  },
);
