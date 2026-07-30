"""Undo everything import_to_db.py wrote, exactly.

Every row the import creates or touches is tagged with the same provenance
string, so the reversal is precise: it removes only rows this import created
and strips only the metadata key it added. Nothing pre-existing is affected.

    python3 rollback_import.py --dry-run
    python3 rollback_import.py --commit
"""
from __future__ import annotations

import argparse

import psycopg

DSN = "postgresql://postgres:tiUIjkivXjqdtVCTtaaQyAwXIchMujFt@switchback.proxy.rlwy.net:16120/railway"
PROVENANCE = "stratum3-manual-scan-2026-07-30"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if not (args.commit or args.dry_run):
        ap.error("pass --dry-run or --commit")

    conn = psycopg.connect(DSN)
    cur = conn.cursor()

    # 1. Scans created by this import.
    cur.execute(
        "select count(*) from signal_scans where category_scores->>'_provenance' = %s",
        (PROVENANCE,),
    )
    scans = cur.fetchone()[0]

    # 2. Entities created by this import: tagged, and with no findings behind
    #    them (an entity the crawler had already seen is one we only updated).
    cur.execute(
        """select count(*) from entities
            where metadata->'stratum3'->>'provenance' = %s
              and finding_count = 0""",
        (PROVENANCE,),
    )
    new_entities = cur.fetchone()[0]

    # 3. Entities that already existed and only had metadata added.
    cur.execute(
        """select count(*) from entities
            where metadata->'stratum3'->>'provenance' = %s
              and finding_count > 0""",
        (PROVENANCE,),
    )
    touched_entities = cur.fetchone()[0]

    # 4. Sources registered by this import.
    cur.execute("select count(*) from sources where notes like %s", (f"Added by {PROVENANCE}%",))
    sources = cur.fetchone()[0]

    print(f"scans to delete            : {scans}")
    print(f"entities to delete (new)   : {new_entities}")
    print(f"entities to un-tag (pre-existing): {touched_entities}")
    print(f"sources to delete          : {sources}")

    if args.commit:
        cur.execute(
            """delete from signal_results where scan_id in (
                 select id from signal_scans
                  where category_scores->>'_provenance' = %s)""",
            (PROVENANCE,),
        )
        cur.execute(
            "delete from signal_scans where category_scores->>'_provenance' = %s",
            (PROVENANCE,),
        )
        # watch_targets and scores may reference the entities we are deleting
        cur.execute(
            """delete from watch_targets where entity_id in (
                 select id from entities
                  where metadata->'stratum3'->>'provenance' = %s and finding_count = 0)""",
            (PROVENANCE,),
        )
        cur.execute(
            """delete from entity_scores where entity_id in (
                 select id from entities
                  where metadata->'stratum3'->>'provenance' = %s and finding_count = 0)""",
            (PROVENANCE,),
        )
        cur.execute(
            """delete from entities
                where metadata->'stratum3'->>'provenance' = %s and finding_count = 0""",
            (PROVENANCE,),
        )
        cur.execute(
            """update entities set metadata = metadata - 'stratum3'
                where metadata->'stratum3'->>'provenance' = %s""",
            (PROVENANCE,),
        )
        cur.execute("delete from sources where notes like %s", (f"Added by {PROVENANCE}%",))
        conn.commit()
        print("\nROLLED BACK")
    else:
        conn.rollback()
        print("\nDRY RUN — nothing changed")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
