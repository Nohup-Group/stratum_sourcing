"""Import discovered + scored companies and their sources into production.

Deliberately ADDITIVE and migration-free. Prod has not had migration 006
applied (that is on the branch, awaiting review), so everything the new schema
would hold — domain, registry id, lifecycle, the eligibility gate, coverage —
goes into the existing `metadata` JSONB under a `stratum3` key. Nothing is
deleted, nothing is overwritten except rows this script itself created, and no
schema is changed.

Usage:
    python3 import_to_db.py --dry-run     # print what would happen
    python3 import_to_db.py --commit      # actually write
"""
from __future__ import annotations

import argparse
import glob
import json
import re
import sys
from datetime import datetime, timezone
from urllib.parse import urlparse

import psycopg

from score_math import rescore
# Share the shortlist's identity and engine-preference rules. The import used to
# dedupe last-wins on a raw name key, so production kept claude-inflated scores
# for companies the shortlist had already corrected to codex — the console and
# the shortlist disagreed.
from build_shortlist import load_scored as load_scored_ranked
from build_shortlist import norm as shortlist_norm

DSN = "postgresql://postgres:tiUIjkivXjqdtVCTtaaQyAwXIchMujFt@switchback.proxy.rlwy.net:16120/railway"
PROVENANCE = "stratum3-manual-scan-2026-07-30"

VERTICAL_TO_TAG = {
    "identity": "identity_permissioning",
    "wallets": "wallets_key_management",
    "compliance": "compliance_trust",
    "data-middleware": "data_oracles_middleware",
}

# sources.category is a fixed enum; map discovery categories onto it.
SOURCE_CATEGORY_MAP = {
    "register": "regulator",
    "sandbox": "regulator",
    "consortium": "association",
    "association": "association",
    "accelerator": "vc",
    "vc_portfolio": "vc",
    "conference": "conference",
    "directory": "association",
}


def normalize_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def host_of(url: str | None) -> str | None:
    if not url:
        return None
    netloc = urlparse(url if "//" in url else "https://" + url).netloc.lower()
    return netloc.removeprefix("www.") or None


# A source is only worth monitoring if it is a LIST that will keep producing
# companies. An analyst's one-off search, or the company's own homepage, is
# where a company was confirmed — not a place to go back to. Registering those
# would refill the sources table with the same kind of noise we are removing.
AD_HOC = re.compile(
    r"(web search|analyst|google|search of|press release|article|news item|"
    r"linkedin post|verified on company|company (site|website|timeline))", re.I)

LIST_CATEGORIES = {
    "register", "sandbox", "accelerator", "vc_portfolio",
    "consortium", "association", "directory", "conference",
}


def is_ingestible_source(
    name: str, url: str, cand: dict, yield_by_url: dict[str, int]
) -> bool:
    if AD_HOC.search(name):
        return False
    # Self-referential: the "source" is the company's own site.
    own = host_of(cand.get("domain"))
    if own and own in url.lower():
        return False
    category = (cand.get("found_via") or {}).get("source_category", "")
    # A recognised list type qualifies on its own; anything else has to have
    # proven itself by surfacing more than one company.
    return category in LIST_CATEGORIES or yield_by_url.get(url, 0) >= 2


def load_scored() -> dict[str, dict]:
    """Scored results, deduped exactly as the shortlist does.

    Keyed on the shortlist's identity function (legal suffixes stripped) with
    its engine preference applied, so production and shortlist.json can never
    disagree about a company's score.
    """
    return load_scored_ranked()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--include-ineligible",
        action="store_true",
        help="Also import gate-failed companies (visible as ineligible, with "
        "their scans) instead of treating them as mere leads.",
    )
    args = ap.parse_args()
    if not (args.commit or args.dry_run):
        ap.error("pass --dry-run or --commit")

    pool = json.load(open("candidate_pool.json", encoding="utf-8"))
    scored = load_scored()
    now = datetime.now(timezone.utc)

    conn = psycopg.connect(DSN)
    cur = conn.cursor()

    # Signal library lookup for per-signal evidence rows.
    cur.execute("select id, number, points from signals")
    signal_by_number = {number: (sid, points) for sid, number, points in cur.fetchall()}
    VERDICT_MAP = {"Y": "confirmed", "N": "absent", "?": "unknown", "NA": "not_applicable"}

    # Only import companies that were actually scored AND passed the gate.
    # An unscored candidate is a lead, not a pipeline company.
    to_import: list[tuple[dict, dict]] = []
    for cand in pool:
        result = scored.get(shortlist_norm(cand["name"]))
        if result is None:
            continue
        verdicts = {"SCORED"} | ({"INELIGIBLE"} if args.include_ineligible else set())
        if result.get("verdict") in verdicts:
            to_import.append((cand, result))

    print(f"candidates      : {len(pool)}")
    print(f"scored          : {len(scored)}")
    print(f"eligible+scored : {len(to_import)}")

    inserted = updated = scans = 0
    for cand, result in to_import:
        # Derived numbers are recomputed from the signal verdicts, never taken
        # from the agent — 18 of 52 audited companies reported a fit that
        # contradicted their own evidence.
        math = rescore(result)
        name = cand["name"].strip()
        norm = shortlist_norm(name) or normalize_name(name)
        domain = host_of(cand.get("domain"))
        tags = [VERTICAL_TO_TAG.get(cand.get("vertical", ""), "")] or []
        tags = [t for t in tags if t]
        eligible = result.get("verdict") == "SCORED"

        # Profile facts: prefer what discovery recorded, fall back to what the
        # scoring session researched — a pool built from a bare name list has
        # "?" everywhere, and "?" must never reach the console profile.
        def fact(pool_key: str, result_key: str):
            v = cand.get(pool_key)
            if v not in (None, "", "?"):
                return v
            return result.get(result_key)

        hq_city, hq_country = cand.get("hq_city"), cand.get("hq_country")
        if hq_city in (None, "", "?"):
            parts = [p.strip() for p in (result.get("hq_city_country") or "").split(",", 1)]
            hq_city = parts[0] or None
            if len(parts) > 1 and hq_country in (None, "", "?"):
                hq_country = parts[1]
        if hq_country == "?":
            hq_country = None

        stratum3 = {
            "provenance": PROVENANCE,
            "lists": ["s3v-pipeline"],
            "domain": domain,
            "registry_id": cand.get("registry_id"),
            "hq_city": hq_city,
            "hq_country": hq_country,
            "founded_year": fact("founded_year", "founded_year"),
            "stage": fact("stage", "stage"),
            "total_raised": fact("total_raised", "total_raised_eur"),
            "raised_eur_m": cand.get("raised_eur_m"),
            "cheque_fit": result.get("cheque_fit") or cand.get("cheque_fit"),
            "sells_to": cand.get("sells_to"),
            "licences": cand.get("licences") or [],
            "founders": result.get("founders") or cand.get("founders") or [],
            "investors": cand.get("investors") or [],
            "found_via": cand.get("found_via") or {},
            "is_eligible": eligible,
            "ineligible_reason": result.get("ineligible_reason"),
            "gate": result.get("gate") or {},
            "coverage": math["coverage"],
            "fit_score": math["fit"],
            "band": math["band"],
            "fit_score_as_reported_by_agent": result.get("fit_score"),
            "signals_resolved": math["counts"]["Y"] + math["counts"]["N"],
            "recommendation": result.get("recommendation"),
            "anti_signals": result.get("anti_signals") or [],
            "research_gaps": result.get("research_gaps") or [],
            "lifecycle_status": "live",
            "imported_at": now.isoformat(),
        }

        # Match on domain first. Name matching created duplicate rows: a
        # discovery agent recorded "Axiology (Lithuanian DLT market
        # infrastructure company)", which normalised to a key that matched no
        # existing entity, so the import inserted a second Axiology and left
        # the stale scan attached to the first.
        row = None
        if domain:
            cur.execute(
                """select id, metadata from entities
                    where entity_type='company'
                      and (domain = %s or canonical_url ilike %s)
                    order by id limit 1""",
                (domain, f"%{domain}%"),
            )
            row = cur.fetchone()
        if row is None:
            cur.execute(
                "select id, metadata from entities where entity_type='company' and normalized_name=%s",
                (norm,),
            )
            row = cur.fetchone()

        if row:
            entity_id, existing_meta = row
            merged = {**(existing_meta or {}), "stratum3": stratum3}
            if args.commit:
                cur.execute(
                    """update entities
                          set metadata=%s,
                              canonical_url=coalesce(%s, canonical_url),
                              description=%s,
                              thesis_tags=%s,
                              domain=%s,
                              registry_id=%s,
                              lifecycle_status='live',
                              lifecycle_checked_at=%s,
                              is_eligible=%s,
                              gate=%s,
                              last_seen_at=%s
                        where id=%s""",
                    (
                        json.dumps(merged),
                        cand.get("domain"),
                        (cand.get("what_it_does") or "")[:2000],
                        tags,
                        domain,
                        cand.get("registry_id"),
                        now,
                        eligible,
                        json.dumps(result.get("gate") or {}),
                        now,
                        entity_id,
                    ),
                )
            updated += 1
        else:
            if args.commit:
                cur.execute(
                    """insert into entities
                       (entity_type, display_name, normalized_name, canonical_url,
                        description, thesis_tags, metadata, first_seen_at, last_seen_at,
                        source_count, finding_count, domain, registry_id,
                        lifecycle_status, lifecycle_checked_at, is_eligible, gate)
                       values ('company', %s, %s, %s, %s, %s, %s, %s, %s, 1, 0,
                               %s, %s, 'live', %s, %s, %s)
                       returning id""",
                    (
                        name,
                        norm,
                        cand.get("domain"),
                        (cand.get("what_it_does") or "")[:2000],
                        tags,
                        json.dumps({"stratum3": stratum3}),
                        now,
                        now,
                        domain,
                        cand.get("registry_id"),
                        now,
                        eligible,
                        json.dumps(result.get("gate") or {}),
                    ),
                )
                entity_id = cur.fetchone()[0]
            else:
                entity_id = None
            inserted += 1

        # Record the manual scan so the console's picks and bands reflect it.
        if not math["signals_total"]:
            continue
        counts = {
            "confirmed": math["counts"]["Y"],
            "absent": math["counts"]["N"],
            "unknown": math["counts"]["?"],
            "not_applicable": math["counts"]["NA"],
        }
        # Idempotent: results keep landing, so this runs more than once. One
        # scan row per entity per provenance — replace it rather than stacking
        # duplicates that would each show up in the console's history.
        if args.commit and entity_id:
            cur.execute(
                """delete from signal_results where scan_id in (
                     select id from signal_scans
                      where entity_id = %s
                        and category_scores->>'_provenance' = %s)""",
                (entity_id, PROVENANCE),
            )
            cur.execute(
                """delete from signal_scans
                    where entity_id = %s and category_scores->>'_provenance' = %s""",
                (entity_id, PROVENANCE),
            )
        scans += 1
        if args.commit and entity_id:
            cur.execute(
                """insert into signal_scans
                   (entity_id, status, scan_depth, trigger, points_earned, points_possible,
                    score_pct, band, veto_flags, category_scores, signals_confirmed,
                    signals_absent, signals_unknown, signals_not_applicable, coverage,
                    rationale, started_at, completed_at)
                   values (%s,'completed','manual','manual-agent',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   returning id""",
                (
                    entity_id,
                    math["points_earned"],
                    math["points_resolved"],
                    math["fit"],
                    math["band"],
                    json.dumps(result.get("veto_flags") or []),
                    json.dumps(
                        {
                            **math["category_scores"],
                            "_coverage": math["coverage"],
                            "_provenance": PROVENANCE,
                        }
                    ),
                    counts["confirmed"],
                    counts["absent"],
                    counts["unknown"],
                    counts["not_applicable"],
                    math["coverage"],
                    (result.get("why") or "")[:4000],
                    now,
                    now,
                ),
            )
            scan_id = cur.fetchone()[0]
            # The scan header without its per-signal rows is a score with no
            # evidence trail — the console's whole pitch. Write every verdict.
            for sig in result.get("signals") or []:
                try:
                    number = int(sig.get("n"))
                except (TypeError, ValueError):
                    continue
                if number not in signal_by_number:
                    continue
                sig_id, sig_points = signal_by_number[number]
                verdict = VERDICT_MAP.get(str(sig.get("verdict", "?")).strip().upper(), "unknown")
                cur.execute(
                    """insert into signal_results
                       (scan_id, signal_id, result, evidence_url, note, points_earned)
                       values (%s,%s,%s,%s,%s,%s)
                       on conflict (scan_id, signal_id) do nothing""",
                    (
                        scan_id,
                        sig_id,
                        verdict,
                        (sig.get("url") or "")[:1000] or None,
                        (sig.get("evidence") or "")[:1000] or None,
                        sig_points if verdict == "confirmed" else 0.0,
                    ),
                )

    # --- sources: every place an on-thesis company was found becomes permanent ---
    # Drawn from the WHOLE candidate pool, not just the scored subset: a
    # register that surfaced eight eligible companies has proven itself as a
    # source whether or not those eight have finished scoring yet.
    src_added = 0
    seen_urls: set[str] = set()
    cur.execute("select coalesce(url,''), name, category from sources")
    rows_existing = cur.fetchall()
    existing_urls = {r[0] for r in rows_existing}
    # sources has a unique (name, category) constraint, and different agents
    # gave the same list slightly different URLs — so both keys must be checked
    # or the whole import aborts on one collision.
    seen_name_cat: set[tuple[str, str]] = {(r[1], r[2]) for r in rows_existing}

    yield_by_url: dict[str, int] = {}
    for cand in pool:
        u = ((cand.get("found_via") or {}).get("source_url") or "").strip()
        if u:
            yield_by_url[u] = yield_by_url.get(u, 0) + 1

    # Highest-yield sources first, so a truncated run still registers the best.
    ranked = sorted(
        pool,
        key=lambda c: -yield_by_url.get(
            ((c.get("found_via") or {}).get("source_url") or "").strip(), 0
        ),
    )

    for cand in ranked:
        fv = cand.get("found_via") or {}
        url, sname = (fv.get("source_url") or "").strip(), (fv.get("source_name") or "").strip()
        if not url or not sname or url in existing_urls or url in seen_urls:
            continue
        if not fv.get("worth_ingesting", True):
            continue
        if not is_ingestible_source(sname, url, cand, yield_by_url):
            continue
        category = SOURCE_CATEGORY_MAP.get(fv.get("source_category", ""), "association")
        if (sname[:255], category) in seen_name_cat:
            continue
        seen_urls.add(url)
        seen_name_cat.add((sname[:255], category))
        cadence = fv.get("cadence") or "weekly"
        bucket = "daily" if cadence == "daily" else "weekly" if cadence == "weekly" else "monthly"
        if args.commit:
            cur.execute(
                """insert into sources
                   (name, category, fetch_strategy, url, description, notes,
                    discovery_mode, cadence_bucket, onboarding_status, verticals,
                    next_ingest_at)
                   values (%s,%s,'web_scrape',%s,%s,%s,'agent_discovered',%s,'active',%s,
                           now() + (random() * interval '6 hours'))""",
                (
                    sname[:255],
                    category,
                    url,
                    (fv.get("why") or "")[:1000],
                    f"Added by {PROVENANCE}. Surfaced {yield_by_url.get(url, 1)} "
                    f"on-thesis European company/companies during the manual discovery sweep.",
                    bucket,
                    [],
                ),
            )
        src_added += 1

    if args.commit:
        conn.commit()
        print(f"\nCOMMITTED  entities inserted={inserted} updated={updated} "
              f"scans={scans} sources={src_added}")
    else:
        conn.rollback()
        print(f"\nDRY RUN    would insert={inserted} update={updated} "
              f"scans={scans} sources={src_added}")
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
