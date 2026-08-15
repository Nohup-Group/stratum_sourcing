"""Apply reclassification.json in bulk, handling identity collisions.

Two earlier attempts failed and are the reason this is written the way it is:

1. A single bulk UPDATE aborted the whole transaction on the first collision
   with uq_entities_type_normalized — retyping the company row "Dagens
   Industri" to `person` collides with a person row of the same name (itself a
   mis-typed media outlet).
2. Doing it row-by-row meant ~3,000 round-trips over the Railway TCP proxy and
   died partway through with "could not receive data from server".

So collisions are computed locally from two bulk SELECTs, and the writes go out
as a dozen array-parameterised UPDATEs instead of thousands of individual ones.

    python3 apply_reclassification.py --dry-run
    python3 apply_reclassification.py --commit
"""
from __future__ import annotations

import os

import argparse
import json
from collections import Counter, defaultdict

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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if not (args.commit or args.dry_run):
        ap.error("pass --dry-run or --commit")

    proposals = json.load(open("reclassification.json", encoding="utf-8"))
    conn = psycopg.connect(_dsn())
    cur = conn.cursor()

    # --- one read: current identity of every entity ---
    cur.execute("select id, entity_type, normalized_name, metadata->'stratum3' from entities")
    rows = cur.fetchall()
    norm_by_id = {r[0]: r[2] for r in rows}
    taken: set[tuple[str, str]] = {(r[1], r[2]) for r in rows}
    # Companies this project imported are verified and gate-passed; never retype
    # or disqualify them.
    protected = {r[0] for r in rows if r[3] is not None}

    retype: dict[str, list[int]] = defaultdict(list)
    ineligible_ids: list[int] = []
    collisions: list[dict] = []
    skipped_protected = 0

    for p in proposals:
        eid = p["id"]
        if eid in protected or eid not in norm_by_id:
            skipped_protected += eid in protected
            continue

        if p["mark_ineligible"]:
            ineligible_ids.append(eid)
            continue

        new_type = p["proposed_type"]
        key = (new_type, norm_by_id[eid])
        if key in taken:
            # Can't move it without violating identity uniqueness — leave the
            # type alone but stop it polluting the company rankings.
            collisions.append({"id": eid, "name": p["name"], "proposed_type": new_type})
            ineligible_ids.append(eid)
            continue

        taken.add(key)
        taken.discard(("company", norm_by_id[eid]))
        retype[new_type].append(eid)

    json.dump(collisions, open("reclassification_collisions.json", "w"), indent=1)

    if args.commit:
        for new_type, ids in retype.items():
            cur.execute(
                "update entities set entity_type=%s, is_eligible=false where id = any(%s)",
                (new_type, ids),
            )
        if ineligible_ids:
            cur.execute(
                "update entities set is_eligible=false where id = any(%s)",
                (ineligible_ids,),
            )
        conn.commit()
        print("COMMITTED")
    else:
        conn.rollback()
        print("DRY RUN")

    counts = Counter({t: len(ids) for t, ids in retype.items()})
    print(f"  retyped                  : {sum(counts.values())}")
    for t, n in counts.most_common():
        print(f"      {n:>5}  {t}")
    print(f"  marked ineligible        : {len(ineligible_ids)}")
    print(f"  collisions (type kept)   : {len(collisions)}")
    print(f"  protected imports skipped: {skipped_protected}")
    if collisions:
        print("  e.g. " + ", ".join(c["name"] for c in collisions[:6]))

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
