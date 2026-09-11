"""Command-line entry point: generate course/<circuit>.json from FastF1 data.

Design ref: 02_design.md sections 4, 4.7, 5. Plan ref: 03_plan.md P1.5, P7.1.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

from .circuits import CIRCUITS
from .session import select_session
from .laps import extract_clean_laps, fastest_lap
from .scale import measure_scale
from .centerline import generate_centerline, DEFAULT_SG_WINDOW, DEFAULT_SG_POLYORDER, DEFAULT_SG_WINDOW_Z
from .width import raw_half_widths, apply_calibration, WidthCalibration
from .geometry import (
    compute_curvature,
    compute_grade,
    compute_bank_zero,
    evaluate_bank_significance,
)
from .export import build_course_document, write_course_json
from .validate import run_all, print_report
from .gripfit import CircuitGripData, fit_pooled_grip_model, load_course_ref

# Determined from measured lap-to-lap lateral scatter (design 4.5): median
# raw p2/p98 full-width scatter on the 2026 Monaco GP race is only 0.16 m,
# so the [8, 12] m floor/ceiling clamp dominates almost everywhere (>96% of
# samples) regardless of k/margin -- Monaco has essentially one viable line
# on most of the lap. k/margin only matter in the naturally-wider braking
# and overtaking zones, where they let width rise above the 8 m floor
# without extrapolating the (mostly near-zero) scatter unrealistically.
DEFAULT_WIDTH_K = 1.6
DEFAULT_WIDTH_MARGIN = 0.5


def interp_periodic(target_s: np.ndarray, src_s: np.ndarray, src_values: np.ndarray, length: float) -> np.ndarray:
    """Linearly interpolate a periodic (closed-loop) signal from one
    arc-length grid onto another, wrapping correctly across the s=0/length
    seam. Both grids must be increasing and cover approximately [0, length).
    """
    ext_s = np.concatenate([src_s - length, src_s, src_s + length])
    ext_values = np.concatenate([src_values, src_values, src_values])
    return np.interp(target_s, ext_s, ext_values)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="gradient-circuit")
    sub = parser.add_subparsers(dest="command", required=True)

    gen = sub.add_parser("generate", help="Generate course/<circuit>.json from FastF1 data")
    gen.add_argument(
        "--circuit", type=str, default="monaco", choices=sorted(CIRCUITS),
        help="Circuit to generate (default: monaco)",
    )
    gen.add_argument("--year", type=int, default=None, help="Explicit year (default: auto-select)")
    gen.add_argument("--session", type=str, default="R", help="Session code (default: R)")
    gen.add_argument("--out", type=Path, required=True, help="Output JSON path")
    gen.add_argument("--sg-window", type=int, default=DEFAULT_SG_WINDOW)
    gen.add_argument("--sg-polyorder", type=int, default=DEFAULT_SG_POLYORDER)
    gen.add_argument("--sg-window-z", type=int, default=DEFAULT_SG_WINDOW_Z)
    gen.add_argument("--width-k", type=float, default=DEFAULT_WIDTH_K)
    gen.add_argument("--width-margin", type=float, default=DEFAULT_WIDTH_MARGIN)

    fit = sub.add_parser(
        "fit-grip",
        help="Fit the speed-dependent grip model (a0, k, a_cap) from real telemetry (design 4.9)",
    )
    fit.add_argument(
        "--circuit", type=str, action="append", default=None, choices=sorted(CIRCUITS),
        help="Circuit to include (repeatable; default: all circuits in circuits.py)",
    )
    fit.add_argument(
        "--course-dir", type=Path, default=Path("../web/public/course"),
        help="Directory holding <circuit>.json (default: ../web/public/course, relative to tools/)",
    )
    fit.add_argument("--year", type=int, default=None, help="Explicit year (default: auto-select, per circuit)")
    fit.add_argument("--session", type=str, default="R", help="Session code (default: R)")

    args = parser.parse_args(argv)

    if args.command == "generate":
        return _run_generate(args)
    if args.command == "fit-grip":
        return _run_fit_grip(args)
    return 1


def _run_generate(args: argparse.Namespace) -> int:
    circuit = CIRCUITS[args.circuit]
    print(f"Selecting {circuit.event_name} session (year={args.year or 'auto'}, session={args.session})...")
    sel = select_session(circuit.event_name, year=args.year, session_code=args.session)
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
    cl = generate_centerline(clean, fastest, scale, args.sg_window, args.sg_polyorder, args.sg_window_z)
    s = cl["s"]
    xyz = cl["xyz"]
    print(f"  -> {len(s)} samples, length={cl['length']:.2f}m, closure_gap={cl['closure_gap']:.4f}m")

    print("Estimating width...")
    half_left_raw, half_right_raw, _ = raw_half_widths(cl["d_buckets"])
    calib = WidthCalibration(k=args.width_k, margin=args.width_margin)
    width_left_ref, width_right_ref, clamp_stats = apply_calibration(
        half_left_raw, half_right_raw, calib, circuit.width_min_m, circuit.width_max_m,
    )
    # d_buckets/z_buckets (and therefore width_left_ref/width_right_ref) are
    # indexed by cl["ref_s"], the grid *before* reparameterize_uniform --
    # not by cl["s"], the final exported grid (measured to differ by 14
    # samples on real data). Interpolate onto the final grid so every
    # exported sample array lines up with the same s.
    width_left = interp_periodic(s, cl["ref_s"], width_left_ref, cl["length"])
    width_right = interp_periodic(s, cl["ref_s"], width_right_ref, cl["length"])
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
        name=circuit.name,
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
    results = run_all(doc, cl["closure_gap"], circuit)
    all_passed = print_report(results)

    write_course_json(doc, args.out)
    print(f"Wrote {args.out}")

    if not all_passed:
        print("ONE OR MORE ACCEPTANCE CRITERIA FAILED", file=sys.stderr)
        return 1
    return 0


def _run_fit_grip(args: argparse.Namespace) -> int:
    circuit_ids = args.circuit or sorted(CIRCUITS)
    circuits: dict[str, CircuitGripData] = {}

    for circuit_id in circuit_ids:
        circuit = CIRCUITS[circuit_id]
        course_path = args.course_dir / f"{circuit_id}.json"
        if not course_path.exists():
            print(
                f"ERROR: {course_path} not found. Run `generate --circuit {circuit_id}` first "
                "(fit-grip projects telemetry onto the exported course, not a freshly built one; design 4.9).",
                file=sys.stderr,
            )
            return 1
        course = load_course_ref(course_path)

        print(f"[{circuit_id}] Selecting {circuit.event_name} session (year={args.year or 'auto'})...")
        sel = select_session(circuit.event_name, year=args.year, session_code=args.session)
        print(f"  -> {sel.year} {sel.event_name} [{sel.session_code}]")

        clean = extract_clean_laps(sel.session)
        scale, _ = measure_scale(clean)
        print(f"  -> {len(clean)} clean laps, scale={scale}")

        circuits[circuit_id] = CircuitGripData(course=course, clean_laps=clean, scale=scale)

    print("\nFitting pooled grip model (all circuits combined, design 4.9)...")
    report = fit_pooled_grip_model(circuits)
    fit = report.fit

    print(f"  n_samples={report.n_samples_total}")
    print("  speed-bin envelope (p95):")
    for i, (v, a, n) in enumerate(zip(report.v_mid, report.a_env, report.counts)):
        marker = " <- peak/fit cutoff" if i == fit.peak_bin_index else ""
        print(f"    {v*3.6:6.0f} km/h  n={n:5d}  a_lat(p95)={a:6.1f} m/s^2 ({a/9.81:.2f} g){marker}")

    print(f"\n  a0 (mechanical grip, v=0) = {fit.a0:.2f} m/s^2 ({fit.a0/9.81:.2f} g)")
    print(f"  k  (aero coefficient)     = {fit.k:.5f} 1/m")
    print(f"  a_cap (saturation)        = {fit.a_cap:.2f} m/s^2 ({fit.a_cap/9.81:.2f} g)")

    print("\n  Tightest-corner check (real speed vs. model speed, top 5% curvature):")
    for circuit_id, tight in report.per_circuit_tight_corner.items():
        if tight is None:
            print(f"    {circuit_id}: no tight-curvature points projected")
            continue
        print(
            f"    {circuit_id}: n={tight.n_points}  real={tight.real_speed_p50_kmh:.0f} km/h  "
            f"model={tight.model_speed_p50_kmh:.0f} km/h  ratio(real/model)={tight.ratio_p50:.2f}"
        )

    print(
        "\nCopy these into web/src/sim/vehicleParams.ts:\n"
        f"  mechLateralAccel: {fit.a0:.2f},\n"
        f"  aeroLateralCoeff: {fit.k:.5f},\n"
        f"  maxLateralAccelCap: {fit.a_cap:.2f},"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
