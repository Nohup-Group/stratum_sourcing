"""Build the outreach shortlist from scored results + the candidate pool.

Ranks eligible, scored companies. A company only reaches the list if it passed
the 7-gate check AND has enough resolved signals to be worth a partner's time —
a high score off three resolved signals is not a finding.
"""
from __future__ import annotations

import glob
import json
import re
import sys

EVIDENCE_GAP = re.compile(
    r"(no amount|undisclosed|not disclosed|no figure|therefore below|"
    r"assumed below|presumed|could not (verify|establish|confirm))", re.I)

from score_math import rescore

MIN_COVERAGE = 0.40


# Legal-entity suffixes only. Deliberately NOT stripping "Labs", "Group",
# "Technologies" or "Holding" — those can distinguish genuinely different
# entities (Centrifuge vs Centrifuge Labs), whereas "Tangany" and "Tangany
# GmbH" are always the same company.
LEGAL_SUFFIX = re.compile(
    r"\b(gmbh|mbh|ag|a\.?g|ab|a/?s|oy|oyj|nv|n\.?v|bv|b\.?v|sa|s\.?a|sas|sarl|"
    r"srl|s\.?r\.?l|spa|s\.?p\.?a|ltd|limited|plc|inc|incorporated|llc|llp|aps|"
    r"kft|sp\s?z\s?o\s?o|se|ug|ou|oü|uab|sia|zrt|d\.?o\.?o)\b\.?", re.I)


def norm(value: str) -> str:
    """Identity key for a scored company.

    Sessions scored the same company under both its trading name and its legal
    name — 21X and 21X AG, Tangany and Tangany GmbH — which put eight companies
    on the shortlist twice. Stripping the legal suffix collapses those.
    """
    text = (value or "").lower()
    # Agents sometimes record a description or the legal name in parentheses —
    # "Axiology (Lithuanian DLT market infrastructure company)", "Eunice
    # (Reasoon Limited)". That made the key unmatchable, so a stale score
    # survived in production while the shortlist showed the corrected one.
    text = re.sub(r"\s*\([^)]*\)", " ", text)
    text = re.sub(r"[^a-z0-9/. ]+", " ", text)
    text = LEGAL_SUFFIX.sub(" ", text)
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


def engine_of(path: str) -> str:
    """Which engine produced a scored file. Tags h*/m* are claude, the rest codex."""
    tag = path.replace("scored_", "").replace(".json", "")
    return "claude" if re.match(r"^(h|m)\d", tag) else "codex"


# Codex and Claude do NOT score the same company the same way. On the one
# head-to-head we have, Axiology, Claude returned 0.74 (strong) and codex 0.43
# (weak) — a 0.31 gap on identical evidence rules. Across the whole run codex
# has a median fit of 0.286 over 280 companies against claude's 0.593 over 8,
# though that comparison is confounded because claude scored the best
# candidates first.
#
# Until the bias is measured properly, the list must at least be internally
# consistent: a company must not look better than its neighbour merely because
# a different engine happened to score it. Codex scored 280 of 288, so codex is
# the reference population and its score wins any tie.
PREFERRED_ENGINE = "codex"


def load_scored() -> dict[str, dict]:
    out: dict[str, dict] = {}
    meta: dict[str, tuple[str, float]] = {}
    for path in sorted(glob.glob("scored_*.json")):
        try:
            rows = json.load(open(path, encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            print(f"  !! {path}: {exc}", file=sys.stderr)
            continue
        eng = engine_of(path)
        for row in rows if isinstance(rows, list) else [rows]:
            if not isinstance(row, dict) or not row.get("company"):
                continue
            key = norm(row["company"])
            cov = rescore(row)["coverage"]
            row = {**row, "_engine": eng}
            if key not in meta:
                out[key], meta[key] = row, (eng, cov)
                continue
            prev_eng, prev_cov = meta[key]
            # Reference engine wins outright; within an engine, take the scan
            # that resolved more of the library. Coverage is recomputed here,
            # never read from the agent's own report.
            better = (eng == PREFERRED_ENGINE and prev_eng != PREFERRED_ENGINE) or (
                eng == prev_eng and cov > prev_cov
            )
            if better:
                out[key], meta[key] = row, (eng, cov)
    return out


def derive_rec(band: str, veto_flags: list) -> str:
    """Derive the verdict from the evidence rather than trusting the agent's label.

    Agent-assigned recommendations overlapped: some 0.54-fit companies were
    labelled "monitor" while some 0.46 were "meet". A derived rule is defensible
    to an investor — "meet means strong or moderate band with no unresolved
    regulatory flag" — and applies identically to every company.

    A veto flag (missing licence for a regulated activity, no AML framework, or
    an adverse enforcement action) drops the verdict one level: it is a reason
    to do more work before the meeting, not a reason to skip the company.
    """
    base = {"strong": "meet", "moderate": "meet", "weak": "monitor"}.get(band, "pass")
    if veto_flags:
        base = {"meet": "monitor", "monitor": "pass"}.get(base, "pass")
    return base


def write_markdown(rows: list[dict]) -> None:
    """Human-readable shortlist for the partners."""
    meet = [r for r in rows if r["rec"] == "meet"]
    monitor = [r for r in rows if r["rec"] == "monitor"]
    rest = [r for r in rows if r["rec"] not in ("meet", "monitor")]

    out = [
        "# Stratum³ outreach shortlist",
        "",
        f"{len(rows)} companies that passed the 7-gate eligibility check and were "
        f"scored against the 200-signal library with coverage >= {MIN_COVERAGE:.0%}.",
        "",
        "`fit` is a weighted blend of per-category fit, counting only signals that "
        "were actually resolved. `cov` is the share of assessed signals resolved — "
        "read them together: a high fit at low coverage is a thin scan, not a good "
        "company.",
        "",
    ]

    def table(title: str, group: list[dict], note: str) -> None:
        if not group:
            return
        out.append(f"## {title} ({len(group)})")
        out.append("")
        out.append(note)
        out.append("")
        out.append("| # | Company | HQ | Founded | Raised | Cheque | Vertical | Fit | Cov | Band |")
        out.append("|---|---|---|---|---|---|---|---|---|---|")
        for i, r in enumerate(group, 1):
            out.append(
                f"| {i} | **[{r['name']}]({r['domain'] or ''})** | {r['hq'] or '?'} | "
                f"{r['founded'] or '?'} | {r['raised'] or '?'} | {r['cheque_fit'] or '?'} | "
                f"{r['vertical'] or '?'} | {r['fit']} | {r['coverage']} | {r['band']} |"
            )
        out.append("")
        for r in group:
            out.append(f"**{r['name']}** — {r['why'] or ''}")
            if r["licences"]:
                out.append(f"  - Licences: {'; '.join(r['licences'][:3])}")
            if r.get("soft_gate_passes"):
                out.append(
                    "  - ⚠️ Gate passed without evidence: "
                    + ", ".join(r["soft_gate_passes"])
                    + " — confirm before the call"
                )
            if r["veto_flags"]:
                flags = "; ".join(
                    f.get("name", str(f)) if isinstance(f, dict) else str(f)
                    for f in r["veto_flags"][:3]
                )
                out.append(f"  - ⚠️ Review flags: {flags}")
            if r["found_via"]:
                out.append(f"  - Found via: {r['found_via']}")
            if r["gaps"]:
                out.append(f"  - Check before the call: {'; '.join(str(g) for g in r['gaps'][:2])}")
            out.append("")

    table("Meet", meet, "Strongest evidence of thesis fit. Worth an intro conversation.")
    table("Monitor", monitor, "Real companies, thinner evidence or earlier than we want today.")
    table("Lower priority", rest, "Passed the gate but scored poorly on resolved signals.")

    open("SHORTLIST.md", "w", encoding="utf-8").write("\n".join(out))


def main() -> None:
    pool = {norm(c["name"]): c for c in json.load(open("candidate_pool.json", encoding="utf-8"))}
    scored = load_scored()

    rows = []
    ineligible = unresolved = thin = 0
    for key, result in scored.items():
        verdict = result.get("verdict")
        if verdict == "INELIGIBLE":
            ineligible += 1
            continue
        if verdict != "SCORED":
            unresolved += 1
            continue
        # Never trust the agent's own arithmetic — recompute from its verdicts.
        # 18 of 52 audited companies had a reported fit that did not match
        # their own signals, almost always understated.
        math = rescore(result)
        coverage = math["coverage"]
        if coverage < MIN_COVERAGE:
            thin += 1
            continue
        cand = pool.get(key, {})
        # Flag gates that "passed" on absence of evidence — 16 of 187 companies
        # passed the capital ceiling purely because no figure was published,
        # which is an unknown, not a pass. Surfacing it stops a demo question
        # like "isn't 360X backed by Deutsche Börse?" landing as a surprise.
        gate = result.get("gate") or {}
        soft_passes = [
            name
            for name, g in gate.items()
            if isinstance(g, dict)
            and str(g.get("result", "")).upper() == "PASS"
            and EVIDENCE_GAP.search(str(g.get("evidence", "")))
        ]
        rows.append(
            {
                "name": result.get("company") or cand.get("name"),
                "domain": cand.get("domain") or result.get("domain"),
                "hq": f"{cand.get('hq_city') or result.get('hq_city_country') or '?'}, "
                f"{cand.get('hq_country') or ''}".strip(", "),
                "founded": cand.get("founded_year") or result.get("founded_year"),
                "stage": cand.get("stage"),
                "raised": cand.get("total_raised") or result.get("total_raised_eur"),
                "cheque_fit": result.get("cheque_fit") or cand.get("cheque_fit"),
                "vertical": cand.get("vertical"),
                "fit": round(math["fit"], 3),
                "coverage": round(coverage, 2),
                "band": math["band"],
                "rec": derive_rec(math["band"], result.get("veto_flags") or []),
                "rec_agent": result.get("recommendation"),
                "fit_reported": round(result.get("fit_score") or 0.0, 3),
                "signals_resolved": math["counts"]["Y"] + math["counts"]["N"],
                "y_without_url": math["y_without_url"],
                "category_scores": math["category_scores"],
                "licences": cand.get("licences") or [],
                "veto_flags": result.get("veto_flags") or [],
                "why": result.get("why") or cand.get("why_on_thesis"),
                "found_via": (cand.get("found_via") or {}).get("source_name"),
                "gaps": result.get("research_gaps") or [],
                "soft_gate_passes": soft_passes,
                "engine": result.get("_engine"),
            }
        )

    order = {"meet": 0, "monitor": 1, "pass": 2, None: 3}
    rows.sort(key=lambda r: (-r["fit"], order.get(r["rec"], 3), -r["coverage"]))

    json.dump(rows, open("shortlist.json", "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    write_markdown(rows)

    print(f"scored records   : {len(scored)}")
    print(f"  ineligible     : {ineligible}")
    print(f"  unresolved     : {unresolved}")
    print(f"  thin (<{MIN_COVERAGE} cov): {thin}")
    print(f"  SHORTLIST      : {len(rows)}  -> shortlist.json\n")

    bands: dict[str, int] = {}
    for r in rows:
        bands[r["band"] or "?"] = bands.get(r["band"] or "?", 0) + 1
    print(f"bands: {bands}\n")

    if rows:
        print(f"{'#':>3} {'company':<26} {'hq':<22} {'fit':>5} {'cov':>5} {'band':<12} {'fit$':<8} rec")
        for i, r in enumerate(rows[:60], 1):
            print(
                f"{i:>3} {(r['name'] or '?')[:25]:<26} {(r['hq'] or '?')[:21]:<22} "
                f"{r['fit']:>5} {r['coverage']:>5} {(r['band'] or '?')[:11]:<12} "
                f"{(r['cheque_fit'] or '?')[:7]:<8} {r['rec'] or '?'}"
            )


if __name__ == "__main__":
    main()
