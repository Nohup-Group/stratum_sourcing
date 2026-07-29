"""Scoring arithmetic for the signal engine.

These lock in the three calibration failures found in production on 2026-07-29:
unknown earning half credit, inapplicable signals scoring as absent, and a thin
scan banding as "moderate".
"""

from __future__ import annotations

import pytest

from app.services.signal_engine import (
    MIN_COVERAGE_FOR_BAND,
    band_for,
    compute_scan_scoring,
)


class FakeSignal:
    """Stand-in for the ORM model — compute_scan_scoring only reads attributes."""

    def __init__(
        self,
        number: int,
        category: str,
        points: float = 2.0,
        strength: str = "high",
        is_veto: bool = False,
    ) -> None:
        self.number = number
        self.category = category
        self.points = points
        self.strength = strength
        self.is_veto = is_veto
        self.name = f"signal-{number}"


def signals(category: str, count: int, start: int = 1) -> list[FakeSignal]:
    return [FakeSignal(start + i, category) for i in range(count)]


def verdicts(**by_number: str) -> dict[int, dict]:
    return {int(n): {"result": r} for n, r in by_number.items()}


@pytest.mark.unit
def test_unknown_is_excluded_from_the_denominator():
    """The Securitize case: 3 confirmed, 2 absent, 58 unknown scored 50.8%.

    Under the old unknown=0.5 rule the floor of the scale was 50%, so ignorance
    read as merit. Unknowns must not move the score at all.
    """
    lib = signals("Founder & Team", 63)
    results = {}
    for s in lib[:3]:
        results[s.number] = {"result": "confirmed"}
    for s in lib[3:5]:
        results[s.number] = {"result": "absent"}
    # remaining 58 deliberately left with no verdict at all

    scoring = compute_scan_scoring(lib, results)

    # 3 confirmed of 5 resolved — the 58 unknowns are invisible to the score
    assert scoring["score_pct"] == pytest.approx(0.6)
    assert scoring["coverage"] == pytest.approx(5 / 63, abs=1e-4)
    assert scoring["counts"]["unknown"] == 58
    # and low coverage must block a band rather than produce "moderate"
    assert scoring["band"] == "insufficient-evidence"


@pytest.mark.unit
def test_not_applicable_is_not_counted_as_absent():
    """An identity vendor cannot hold an EMI licence — that is NA, not a miss.

    Counting inapplicable signals as absent systematically under-ranks whole
    verticals, which is what happened to the identity segment.
    """
    lib = signals("Regulatory & Compliance", 10)
    penalised = {s.number: {"result": "absent"} for s in lib[:5]}
    penalised.update({s.number: {"result": "confirmed"} for s in lib[5:]})

    excused = {s.number: {"result": "not_applicable"} for s in lib[:5]}
    excused.update({s.number: {"result": "confirmed"} for s in lib[5:]})

    assert compute_scan_scoring(lib, penalised)["score_pct"] == pytest.approx(0.5)
    assert compute_scan_scoring(lib, excused)["score_pct"] == pytest.approx(1.0)
    assert compute_scan_scoring(lib, excused)["counts"]["not_applicable"] == 5


@pytest.mark.unit
def test_score_is_weighted_by_category_not_by_library_size():
    """Founder & Team (0.30) must outweigh Technology & Product (0.12).

    A flat point sum would let the 40-signal technology category dominate the
    30-signal regulatory one purely on library size.
    """
    founder = signals("Founder & Team", 2, start=1)
    tech = signals("Technology & Product", 20, start=100)

    strong_founder = {s.number: {"result": "confirmed"} for s in founder}
    strong_founder.update({s.number: {"result": "absent"} for s in tech})

    strong_tech = {s.number: {"result": "absent"} for s in founder}
    strong_tech.update({s.number: {"result": "confirmed"} for s in tech})

    lib = founder + tech
    founder_led = compute_scan_scoring(lib, strong_founder)["score_pct"]
    tech_led = compute_scan_scoring(lib, strong_tech)["score_pct"]

    assert founder_led > tech_led
    assert founder_led == pytest.approx(0.30 / 0.42, abs=1e-3)


@pytest.mark.unit
def test_empty_category_drops_out_of_the_blend_rather_than_scoring_zero():
    lib = signals("Founder & Team", 2) + signals("Market Presence", 2, start=50)
    only_founder = {s.number: {"result": "confirmed"} for s in lib[:2]}

    scoring = compute_scan_scoring(lib, only_founder)

    assert scoring["score_pct"] == pytest.approx(1.0)
    assert scoring["category_scores"]["Market Presence"]["fit"] is None


@pytest.mark.unit
def test_veto_flags_on_absent_but_does_not_zero_the_score():
    lib = [
        FakeSignal(81, "Regulatory & Compliance", is_veto=True),
        FakeSignal(82, "Regulatory & Compliance"),
    ]
    scoring = compute_scan_scoring(
        lib, verdicts(**{"81": "absent", "82": "confirmed"})
    )

    assert [f["number"] for f in scoring["veto_flags"]] == [81]
    assert scoring["score_pct"] == pytest.approx(0.5)


@pytest.mark.unit
def test_unrecognised_verdict_degrades_to_unknown_not_to_credit():
    lib = signals("Founder & Team", 2)
    scoring = compute_scan_scoring(
        lib, {lib[0].number: {"result": "probably"}, lib[1].number: {"result": "confirmed"}}
    )

    assert scoring["counts"]["unknown"] == 1
    assert scoring["score_pct"] == pytest.approx(1.0)
    assert scoring["coverage"] == pytest.approx(0.5)


@pytest.mark.unit
@pytest.mark.parametrize(
    ("fit", "coverage", "expected"),
    [
        (0.95, 0.9, "strong"),
        (0.70, 0.9, "strong"),
        (0.69, 0.9, "moderate"),
        (0.50, 0.9, "moderate"),
        (0.35, 0.9, "weak"),
        (0.10, 0.9, "poor"),
        (0.95, MIN_COVERAGE_FOR_BAND - 0.01, "insufficient-evidence"),
        (0.10, 0.0, "insufficient-evidence"),
    ],
)
def test_bands_require_coverage(fit, coverage, expected):
    assert band_for(fit, coverage) == expected


@pytest.mark.unit
def test_no_signals_resolved_is_zero_not_a_crash():
    lib = signals("Founder & Team", 5)
    scoring = compute_scan_scoring(lib, {})

    assert scoring["score_pct"] == 0.0
    assert scoring["coverage"] == 0.0
    assert scoring["band"] == "insufficient-evidence"
