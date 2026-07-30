"""Recompute fit, coverage and band from raw signal verdicts.

An audit of 52 agent-scored companies found 18 whose reported fit_score did not
match their own signal verdicts — almost always reported LOWER than the
arithmetic supports (Enable Banking 0.423 vs 0.513, CryptoNext 0.331 vs 0.481),
and one catastrophic case (Eunice, reported 0.0/0.0 against a real 0.642/0.96).

So the reported numbers are not used. The `signals` array is the primary
evidence — that is the part the research actually produced — and every derived
number is computed here, identically for every company regardless of which
model scored it. That removes model arithmetic from the pipeline entirely and
makes scores from different models comparable, since only verdict generosity
can differ, not the maths.
"""
from __future__ import annotations

CATEGORY_WEIGHTS = {
    "Founder & Team": 0.30,
    "Regulatory & Compliance": 0.20,
    "Commercial Traction": 0.20,
    "Technology & Product": 0.12,
    "Investor & Funding": 0.10,
    "Market Presence": 0.04,
    "Structural & Strategic": 0.04,
}
STRENGTH_POINTS = {"high": 2.0, "medium": 1.0}
MIN_COVERAGE_FOR_BAND = 0.40
BAND_THRESHOLDS = ((0.70, "strong"), (0.50, "moderate"), (0.35, "weak"))

# Agents spell categories inconsistently; map the common variants back.
CATEGORY_ALIASES = {
    "founder": "Founder & Team",
    "founder and team": "Founder & Team",
    "team": "Founder & Team",
    "regulatory": "Regulatory & Compliance",
    "regulatory and compliance": "Regulatory & Compliance",
    "compliance": "Regulatory & Compliance",
    "commercial": "Commercial Traction",
    "commercial traction": "Commercial Traction",
    "traction": "Commercial Traction",
    "technology": "Technology & Product",
    "technology and product": "Technology & Product",
    "product": "Technology & Product",
    "tech": "Technology & Product",
    "investor": "Investor & Funding",
    "investor and funding": "Investor & Funding",
    "funding": "Investor & Funding",
    "market": "Market Presence",
    "market presence": "Market Presence",
    "structural": "Structural & Strategic",
    "structural and strategic": "Structural & Strategic",
    "strategic": "Structural & Strategic",
}


def canon_category(raw: str | None) -> str | None:
    if not raw:
        return None
    text = str(raw).strip()
    if text in CATEGORY_WEIGHTS:
        return text
    key = text.lower().replace("&", "and").replace("_", " ").strip()
    key = " ".join(key.split())
    return CATEGORY_ALIASES.get(key)


def band_for(fit: float, coverage: float) -> str:
    if coverage < MIN_COVERAGE_FOR_BAND:
        return "insufficient-evidence"
    for threshold, band in BAND_THRESHOLDS:
        if fit >= threshold:
            return band
    return "poor"


def rescore(result: dict) -> dict:
    """Return {fit, coverage, band, category_scores, counts, y_without_url}.

    Y and N score; ? and NA are excluded from both numerator and denominator.
    """
    signals = result.get("signals") or []
    cats: dict[str, list[float]] = {}
    counts = {"Y": 0, "N": 0, "?": 0, "NA": 0}
    y_without_url = 0
    uncategorised = 0

    for sig in signals:
        verdict = str(sig.get("verdict", "?")).strip().upper()
        if verdict in ("YES", "TRUE"):
            verdict = "Y"
        elif verdict in ("NO", "FALSE"):
            verdict = "N"
        elif verdict in ("N/A", "NOT_APPLICABLE"):
            verdict = "NA"
        elif verdict not in ("Y", "N", "NA"):
            verdict = "?"
        counts[verdict] += 1

        if verdict == "Y" and not str(sig.get("url") or "").strip():
            y_without_url += 1
        if verdict not in ("Y", "N"):
            continue

        category = canon_category(sig.get("category"))
        if category is None:
            uncategorised += 1
            continue
        points = STRENGTH_POINTS.get(str(sig.get("strength", "high")).lower(), 2.0)
        bucket = cats.setdefault(category, [0.0, 0.0])
        bucket[1] += points
        if verdict == "Y":
            bucket[0] += points

    numerator = denominator = 0.0
    category_scores = {}
    for category, (earned, resolved) in cats.items():
        if not resolved:
            continue
        fit_c = earned / resolved
        weight = CATEGORY_WEIGHTS[category]
        numerator += weight * fit_c
        denominator += weight
        category_scores[category] = {
            "earned": round(earned, 2),
            "resolved": round(resolved, 2),
            "fit": round(fit_c, 4),
        }

    fit = round(numerator / denominator, 4) if denominator else 0.0
    resolved_n = counts["Y"] + counts["N"]
    assessed = sum(counts.values())
    coverage = round(resolved_n / assessed, 4) if assessed else 0.0

    return {
        "fit": fit,
        "points_earned": round(sum(c["earned"] for c in category_scores.values()), 2),
        "points_resolved": round(sum(c["resolved"] for c in category_scores.values()), 2),
        "coverage": coverage,
        "band": band_for(fit, coverage),
        "category_scores": category_scores,
        "counts": counts,
        "y_without_url": y_without_url,
        "uncategorised_signals": uncategorised,
        "signals_total": assessed,
    }
