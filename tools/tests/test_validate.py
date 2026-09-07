"""Unit tests for acceptance-criteria checks."""

from __future__ import annotations

import numpy as np

from gradient_circuit.validate import run_all


def _make_doc(count: int = 3337, width: float = 8.5) -> dict:
    s = np.arange(count) * 1.0
    theta = s / count * 2 * np.pi
    radius = 3337.0 / (2 * np.pi)
    x = radius * np.cos(theta)
    y = radius * np.sin(theta)
    z = 20 + 20 * np.sin(theta)  # ~40m elevation delta
    curvature = np.full(count, 1.0 / radius)
    return {
        "length": 3337.0,
        "count": count,
        "samples": {
            "s": s.tolist(),
            "x": x.tolist(),
            "y": y.tolist(),
            "z": z.tolist(),
            "widthLeft": (np.full(count, width / 2)).tolist(),
            "widthRight": (np.full(count, width / 2)).tolist(),
            "curvature": curvature.tolist(),
            "grade": np.zeros(count).tolist(),
            "bank": np.zeros(count).tolist(),
        },
    }


def test_valid_document_passes_all_checks():
    doc = _make_doc()
    results = run_all(doc, closure_gap=0.5)
    assert all(r.passed for r in results)


def test_width_out_of_range_fails_only_that_check():
    doc = _make_doc(width=2.0)  # way under the 8-12m target
    results = run_all(doc, closure_gap=0.5)
    by_id = {r.id: r for r in results}
    assert not by_id[3].passed
    assert by_id[1].passed  # length unaffected
    assert by_id[4].passed  # closure unaffected


def test_nan_is_detected():
    doc = _make_doc()
    doc["samples"]["z"][10] = float("nan")
    results = run_all(doc, closure_gap=0.5)
    by_id = {r.id: r for r in results}
    assert not by_id[6].passed


def test_mismatched_array_length_is_detected():
    """Regression guard for the real bug: widthLeft/widthRight computed on
    a different sample grid than x/y/z/s, exported with a mismatched
    length that only the web loader's check caught."""
    doc = _make_doc()
    doc["samples"]["widthLeft"] = doc["samples"]["widthLeft"] + [8.0] * 14
    doc["samples"]["widthRight"] = doc["samples"]["widthRight"] + [8.0] * 14
    results = run_all(doc, closure_gap=0.5)
    by_id = {r.id: r for r in results}
    assert not by_id[7].passed
    assert by_id[1].passed  # unrelated checks still run
