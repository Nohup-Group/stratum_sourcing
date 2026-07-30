"""Propose a corrected entity_type for every row currently typed 'company'.

The extractor types every proper noun as a company, so the table holds
regulators, VCs, media, tokens, laws, countries, AI models and people. This
emits a reclassification proposal, reviewable before anything is written.

Writes reclassification.json and reclassification.sql. Applying the SQL requires
migration 006 (which widens the entity_type enum) to have run first.

    python3 reclassify_entities.py            # propose only
    python3 reclassify_entities.py --apply    # write metadata flags to prod
                                              # (metadata only, no type change,
                                              #  so it is safe pre-migration)
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys

import triage  # reuse the classifier already validated against this data

# triage's exclusion reasons -> the entity_type they should become
REASON_TO_TYPE = {
    "person": "person",
    "person-like": "person",
    "investor": "investor",
    "investor-like": "investor",
    "regulator/government": "regulator",
    "media/data-provider": "media",
    "media/event/institution": "event",
    "place": "place",
    "generic-noun": "concept",
    "standard/law/concept": "standard",
    "ai-model/product": "product",
    "ticker/acronym": "token",
    # these stay companies but are out of thesis
    "incumbent/too-late": "company",
    "late-stage-signal": "company",
    "no-thesis-signal": "company",
}

# triage's heuristics were tuned to FILTER candidates, where a false exclusion
# is cheap. Assigning a type is different — a wrong type is a wrong claim about
# the entity — so these override it on the cases it demonstrably gets wrong.
ACADEMIC = re.compile(
    r"(universit|institute of technology|business school|\bschool\b|högskolan|"
    r"\bcollege\b|\bfaculty\b|academy of|research council)", re.I)
ASSOCIATION = re.compile(
    r"(association|consortium|federation|\bcouncil\b|\bchamber\b|\balliance\b|"
    r"foundation|\bsociety\b|\bbody\b|initiative|working group|standards? body)", re.I)
EVENT = re.compile(
    r"(\bweek\b|\bsummit\b|\bforum\b|conference|\bexpo\b|\bawards?\b|festival|"
    r"20/20|money20|\bdays?\b\s|hackathon)", re.I)
MEDIA = re.compile(
    r"(news|magazine|journal|\btimes\b|\bpost\b|\bwire\b|podcast|newsletter|"
    r"\bweekly\b|\bdaily\b|\breport\b|research|analytics|\bdata\b)", re.I)


def refine(name: str, proposed: str, people_full: set[str]) -> str:
    """Correct the type where triage's filter heuristics misfire."""
    low = name.lower().strip()

    # triage flags "person-like" on a first-token match against the people
    # table, which mislabels "Blockchain for Europe" and "Solana Developer
    # Platform". Only a full-name match is real evidence of a person.
    if proposed == "person" and low not in people_full:
        proposed = "company"

    # Order matters: an academic institute that also says "Foundation" is
    # academic first.
    if ACADEMIC.search(name):
        return "academic"
    if ASSOCIATION.search(name):
        return "association"
    if EVENT.search(name):
        return "event"
    if proposed == "event" and MEDIA.search(name):
        return "media"
    return proposed


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    people = set()
    with open("people.txt", encoding="utf-8") as fh:
        for line in fh:
            name = line.strip().lower()
            if name:
                people.add(name)
                triage.people_first_names.add(name.split()[0].title())

    rows = []
    with open("all_1825.tsv", encoding="utf-8") as fh:
        for parts in csv.reader(fh, delimiter="\t"):
            if len(parts) >= 7:
                rows.append(parts)

    proposals = []
    counts: dict[str, int] = {}
    for eid, _score, _fc, _sc, name, _url, desc in rows:
        verdict, reason = triage.classify(name, desc, people)
        new_type = "company" if verdict == "candidate" else REASON_TO_TYPE.get(reason, "concept")
        new_type = refine(name, new_type, people)
        # A row that stays a company but failed the thesis screen is still a
        # company — it is just not eligible. Those are two different facts.
        ineligible = verdict != "candidate" and new_type == "company"
        if new_type == "company" and not ineligible:
            continue
        proposals.append(
            {
                "id": int(eid),
                "name": name,
                "current_type": "company",
                "proposed_type": new_type,
                "reason": reason,
                "mark_ineligible": ineligible,
            }
        )
        key = f"{new_type} ({reason})" if ineligible else new_type
        counts[key] = counts.get(key, 0) + 1

    json.dump(proposals, open("reclassification.json", "w", encoding="utf-8"),
              indent=1, ensure_ascii=False)

    with open("reclassification.sql", "w", encoding="utf-8") as fh:
        fh.write("-- Reclassify entities mis-typed as companies by the extractor.\n")
        fh.write("-- REQUIRES migration 006 (widens the entity_type enum).\n")
        fh.write("-- Review reclassification.json before running.\n")
        fh.write("BEGIN;\n")
        by_type: dict[str, list[int]] = {}
        ineligible_ids: list[int] = []
        for p in proposals:
            if p["mark_ineligible"]:
                ineligible_ids.append(p["id"])
            else:
                by_type.setdefault(p["proposed_type"], []).append(p["id"])
        for new_type, ids in sorted(by_type.items()):
            fh.write(f"\n-- {len(ids)} rows -> {new_type}\n")
            for chunk_start in range(0, len(ids), 200):
                chunk = ids[chunk_start : chunk_start + 200]
                fh.write(
                    f"UPDATE entities SET entity_type='{new_type}' "
                    f"WHERE id IN ({','.join(map(str, chunk))});\n"
                )
        if ineligible_ids:
            fh.write(f"\n-- {len(ineligible_ids)} rows stay companies but fail the thesis gate\n")
            for chunk_start in range(0, len(ineligible_ids), 200):
                chunk = ineligible_ids[chunk_start : chunk_start + 200]
                fh.write(
                    f"UPDATE entities SET is_eligible=false "
                    f"WHERE id IN ({','.join(map(str, chunk))});\n"
                )
        fh.write("\nCOMMIT;\n")

    total = len(rows)
    print(f"rows examined     : {total}")
    print(f"rows to change    : {len(proposals)}")
    print(f"rows left as-is   : {total - len(proposals)}\n")
    for key, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"{n:>5}  {key}")
    print("\nwrote reclassification.json and reclassification.sql")

    if args.apply:
        # Metadata-only write: records the proposal against each row without
        # touching entity_type, so it is safe before migration 006 lands.
        import psycopg

        conn = psycopg.connect(
            "postgresql://postgres:tiUIjkivXjqdtVCTtaaQyAwXIchMujFt"
            "@switchback.proxy.rlwy.net:16120/railway"
        )
        cur = conn.cursor()
        for p in proposals:
            cur.execute(
                """update entities
                      set metadata = jsonb_set(
                          coalesce(metadata,'{}'::jsonb), '{proposed_reclassification}', %s::jsonb)
                    where id = %s""",
                (json.dumps({"type": p["proposed_type"], "reason": p["reason"],
                             "ineligible": p["mark_ineligible"]}), p["id"]),
            )
        conn.commit()
        print(f"APPLIED metadata flags to {len(proposals)} rows (no type changed)")
        cur.close()
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
