"""Merge company rows that share a domain.

The import matched entities on a normalised display name, so a company recorded
under two spellings — "Axiology" and "Axiology (Lithuanian DLT market
infrastructure company)", "21X AG" and "21X" — became two rows. The second row
got the fresh scan while the first kept a stale one, which is why the console
showed Axiology at 74% strong long after the shortlist had corrected it to weak.

Domain is the real identity, so rows are merged on it.

Survivor = the row with the most findings (real pipeline history), tie-broken to
the lowest id. A duplicate is only deleted when it is one this import created
(provenance-tagged) and carries no findings of its own; anything else is left
alone and reported, because losing crawler history would be worse than a
duplicate.

    python3 merge_duplicate_entities.py --dry-run
    python3 merge_duplicate_entities.py --commit
"""
from __future__ import annotations

import os

import argparse

import psycopg

def _dsn() -> str:
    """Connection string from the environment; never baked into the file.

    DATABASE_URL is the app's SQLAlchemy URL (postgresql+asyncpg://...), which
    psycopg cannot parse, so the driver marker is stripped.
    """
    url = os.environ.get("SOURCING_DSN") or os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit(
            "set SOURCING_DSN or DATABASE_URL to the target database before running this"
        )
    return url.replace("+asyncpg", "")
PROVENANCE = "stratum3-manual-scan-2026-07-30"

# Every table that references entities.id, so a delete cannot orphan a row.
DEPENDENTS = (
    ("signal_results", "scan_id in (select id from signal_scans where entity_id = %s)"),
    ("signal_scans", "entity_id = %s"),
    ("watch_targets", "entity_id = %s"),
    ("entity_scores", "entity_id = %s"),
    ("entity_mentions", "entity_id = %s"),
    ("entity_research_snapshots", "entity_id = %s"),
    ("event_outbox", "entity_id = %s"),
    ("agent_jobs", "entity_id = %s"),
)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if not (args.commit or args.dry_run):
        ap.error("pass --dry-run or --commit")

    conn = psycopg.connect(_dsn())
    cur = conn.cursor()

    cur.execute(
        """select domain, array_agg(id order by finding_count desc, id)
             from entities
            where entity_type = 'company' and domain is not null and domain <> ''
            group by domain having count(*) > 1"""
    )
    groups = cur.fetchall()

    merged = kept_for_safety = 0
    for domain, ids in groups:
        survivor, *losers = ids
        for loser in losers:
            cur.execute(
                """select finding_count, source_count,
                          metadata->'stratum3'->>'provenance', display_name
                     from entities where id = %s""",
                (loser,),
            )
            findings, sources, prov, name = cur.fetchone()
            if findings > 0 or prov != PROVENANCE:
                kept_for_safety += 1
                print(f"  keep  {loser} '{name}' ({domain}) — {findings} findings, prov={prov}")
                continue

            print(f"  merge {loser} '{name}' -> {survivor}  ({domain})")
            if args.commit:
                for table, where in DEPENDENTS:
                    cur.execute(f"delete from {table} where {where}", (loser,))
                cur.execute("delete from entities where id = %s", (loser,))
            merged += 1

    if args.commit:
        conn.commit()
        print(f"\nCOMMITTED  merged={merged}  left alone={kept_for_safety}")
    else:
        conn.rollback()
        print(f"\nDRY RUN    would merge={merged}  leave alone={kept_for_safety}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
