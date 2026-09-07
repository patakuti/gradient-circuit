"""Command-line entry point: generate course/monaco.json from FastF1 data.

Design ref: 02_design.md sections 4, 5. Plan ref: 03_plan.md P1.5.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

from .session import select_monaco_session
from .laps import extract_clean_laps, fastest_lap
from .scale import measure_scale
from .centerline import generate_centerline, DEFAULT_SG_WINDOW, DEFAULT_SG_POLYORDER
from .width import raw_half_widths, apply_calibration, WidthCalibration
from .geometry import (
    compute_curvature,
    compute_grade,
    compute_bank_zero,
    evaluate_bank_significance,
)
from .export import build_course_document, write_course_json
from .validate import run_all, print_report

# Determined from measured lap-to-lap lateral scatter (design 4.5): median
# raw p2/p98 full-width scatter on the 2026 Monaco GP race is only 0.16 m,
# so the [8, 12] m floor/ceiling clamp dominates almost everywhere (>96% of
# samples) regardless of k/margin -- Monaco has essentially one viable line
# on most of the lap. k/margin only matter in the naturally-wider braking
# and overtaking zones, where they let width rise above the 8 m floor
# without extrapolating the (mostly near-zero) scatter unrealistically.
DEFAULT_WIDTH_K = 1.6
DEFAULT_WIDTH_MARGIN = 0.5


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="gradient-circuit")
    sub = parser.add_subparsers(dest="command", required=True)

    gen = sub.add_parser("generate", help="Generate course/monaco.json from FastF1 data")
    gen.add_argument("--year", type=int, default=None, help="Explicit year (default: auto-select)")
    gen.add_argument("--session", type=str, default="R", help="Session code (default: R)")
    gen.add_argument("--out", type=Path, required=True, help="Output JSON path")
    gen.add_argument("--sg-window", type=int, default=DEFAULT_SG_WINDOW)
    gen.add_argument("--sg-polyorder", type=int, default=DEFAULT_SG_POLYORDER)
    gen.add_argument("--width-k", type=float, default=DEFAULT_WIDTH_K)
    gen.add_argument("--width-margin", type=float, default=DEFAULT_WIDTH_MARGIN)

    args = parser.parse_args(argv)

    if args.command == "generate":
        return _run_generate(args)
    return 1


def _run_generate(args: argparse.Namespace) -> int:
    print(f"Selecting Monaco GP session (year={args.year or 'auto'}, session={args.session})...")
    sel = select_monaco_session(year=args.year, session_code=args.session)
    print(f"  -> {sel.year} {sel.event_name} [{sel.session_code}]")

    print("Extracting clean laps...")
    clean = extract_clean_laps(sel.session)
    drivers_used = sorted(set(c.driver for c in clean))
    print(f"  -> {len(clean)} clean laps, {len(drivers_used)} drivers")

    print("Measuring raw-unit scale...")
    scale, scale_stats = measure_scale(clean)
    print(f"  -> scale={scale} (measured median={scale_stats['median']:.6f}, "
          f"n={scale_stats['n_laps']} laps)")

    fastest = fastest_lap(clean)
    print(f"Reference lap: {fastest.driver} #{fastest.lap_number} ({fastest.lap_time_s:.3f}s)")

    print("Generating centerline...")
    cl = generate_centerline(clean, fastest, scale, args.sg_window, args.sg_polyorder)
    s = cl["s"]
    xyz = cl["xyz"]
    print(f"  -> {len(s)} samples, length={cl['length']:.2f}m, closure_gap={cl['closure_gap']:.4f}m")

    print("Estimating width...")
    half_left_raw, half_right_raw, _ = raw_half_widths(cl["d_buckets"])
    calib = WidthCalibration(k=args.width_k, margin=args.width_margin)
    width_left, width_right, clamp_stats = apply_calibration(half_left_raw, half_right_raw, calib)
    print(f"  -> half_clamp_rate={clamp_stats['half_clamp_rate']*100:.2f}% "
          f"full_clamp_rate={clamp_stats['full_clamp_rate']*100:.2f}%")

    print("Computing geometry (curvature, grade)...")
    curvature = compute_curvature(xyz)
    grade = compute_grade(xyz)

    print("Evaluating bank-angle significance...")
    bank_stats = evaluate_bank_significance(cl["d_buckets"], cl["z_buckets"])
    coverage = bank_stats["n_samples_evaluated"] / len(s)
    print(f"  -> evaluable samples: {bank_stats['n_samples_evaluated']}/{len(s)} "
          f"({coverage*100:.1f}% of track has enough lateral spread to attempt regression)")
    print(f"  -> median_r2={bank_stats['median_r2']:.3f} "
          f"frac_significant(R2>0.3)={bank_stats['frac_significant']*100:.1f}%")
    # Design 4.6: adopt lateral-regression bank only with sufficient, broad
    # significance. Measured on the 2026 Monaco GP race data: only ~15% of
    # the track even has enough lateral spread to attempt the regression at
    # all (matches the width-calibration finding of near-zero lap-to-lap
    # scatter almost everywhere, design 4.5), and even among that subset the
    # median R^2 (~0.34) is weak-to-moderate, not a clear signal. This does
    # not clear the bar for adopting bank -- disabled, per design's default.
    bank_source = "disabled"
    bank = compute_bank_zero(len(s))
    print(f"  -> bank_source={bank_source} (evidence insufficient; see design 4.6)")

    doc = build_course_document(
        name="Circuit de Monaco",
        event=sel.event_name,
        year=sel.year,
        session_code=sel.session_code,
        laps_used=len(clean),
        drivers_used=drivers_used,
        scale=scale,
        bank_source=bank_source,
        width_k=calib.k,
        width_margin=calib.margin,
        s=s,
        xyz=xyz,
        width_left=width_left,
        width_right=width_right,
        curvature=curvature,
        grade=grade,
        bank=bank,
        length=cl["length"],
        ds=1.0,
    )

    print("Validating...")
    results = run_all(doc, cl["closure_gap"])
    all_passed = print_report(results)

    write_course_json(doc, args.out)
    print(f"Wrote {args.out}")

    if not all_passed:
        print("ONE OR MORE ACCEPTANCE CRITERIA FAILED", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
