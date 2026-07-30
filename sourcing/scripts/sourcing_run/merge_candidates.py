"""Merge every disc_*.json discovery file into one deduped candidate pool.

Dedupe key is the registrable domain, never the display name — name collisions
are the single most common capture error in this pipeline.
"""
from __future__ import annotations

import glob
import json
import re
import sys
from urllib.parse import urlparse

RAISE_RE = re.compile(r"([\d.,]+)\s*(m|million|bn|billion|k)?", re.I)


def domain_key(url: str | None, name: str) -> str:
    if not url:
        return "name:" + re.sub(r"[^a-z0-9]", "", (name or "").lower())
    host = urlparse(url if "//" in url else "https://" + url).netloc.lower()
    host = host.removeprefix("www.")
    return host or "name:" + re.sub(r"[^a-z0-9]", "", (name or "").lower())


def raised_eur_m(text: str | None) -> float | None:
    """Best-effort parse of a raise string to EUR millions. None if unknown."""
    if not text:
        return None
    t = text.lower()
    if "undisclosed" in t or "unknown" in t:
        return None
    # prefer a parenthesised EUR figure if present, e.g. "$26m (~€24m)"
    eur = re.search(r"€\s*~?([\d.,]+)\s*(m|million|bn|billion)?", t)
    m = eur or RAISE_RE.search(t)
    if not m:
        return None
    try:
        value = float(m.group(1).replace(",", "."))
    except ValueError:
        return None
    unit = (m.group(2) or "m").lower()
    if unit.startswith("b"):
        value *= 1000
    elif unit == "k":
        value /= 1000
    if not eur and "$" in t:
        value *= 0.92
    elif not eur and "£" in t:
        value *= 1.17
    return round(value, 2)


def cheque_fit(eur_m: float | None) -> str:
    if eur_m is None:
        return "unknown"
    if eur_m < 20:
        return "core"
    if eur_m < 30:
        return "stretch"
    return "over-ceiling"


def main() -> None:
    pool: dict[str, dict] = {}
    per_file: dict[str, int] = {}

    for path in sorted(glob.glob("disc_*.json")):
        try:
            rows = json.load(open(path, encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001 - a broken file must not stop the merge
            print(f"  !! {path}: {exc}", file=sys.stderr)
            continue
        if isinstance(rows, dict):
            rows = [rows]
        per_file[path] = len(rows)

        for row in rows:
            if not isinstance(row, dict) or not row.get("name"):
                continue
            key = domain_key(row.get("domain"), row["name"])
            eur = raised_eur_m(row.get("total_raised"))
            row = {
                **row,
                "raised_eur_m": eur,
                "cheque_fit": row.get("cheque_fit") or cheque_fit(eur),
                "found_in_files": [path],
            }
            if key in pool:
                existing = pool[key]
                existing["found_in_files"].append(path)
                # keep the record with more populated fields
                if sum(1 for v in row.values() if v) > sum(
                    1 for v in existing.values() if v
                ):
                    row["found_in_files"] = existing["found_in_files"]
                    pool[key] = row
            else:
                pool[key] = row

    companies = list(pool.values())
    over = [c for c in companies if c["cheque_fit"] == "over-ceiling"]
    keep = [c for c in companies if c["cheque_fit"] != "over-ceiling"]
    keep.sort(key=lambda c: (c.get("confidence") != "high", c.get("name", "").lower()))

    json.dump(keep, open("candidate_pool.json", "w", encoding="utf-8"), indent=1, ensure_ascii=False)

    print("=== per file ===")
    for path, count in per_file.items():
        print(f"{count:>4}  {path}")
    print(f"\nunique by domain : {len(companies)}")
    print(f"over ceiling     : {len(over)}  -> dropped")
    print(f"candidate pool   : {len(keep)}  -> candidate_pool.json")
    by_fit: dict[str, int] = {}
    by_conf: dict[str, int] = {}
    by_vert: dict[str, int] = {}
    for c in keep:
        by_fit[c["cheque_fit"]] = by_fit.get(c["cheque_fit"], 0) + 1
        by_conf[c.get("confidence", "?")] = by_conf.get(c.get("confidence", "?"), 0) + 1
        by_vert[c.get("vertical", "?")] = by_vert.get(c.get("vertical", "?"), 0) + 1
    print(f"\ncheque_fit : {by_fit}")
    print(f"confidence : {by_conf}")
    print(f"vertical   : {by_vert}")
    if over:
        print("\ndropped over ceiling: " + ", ".join(
            f"{c['name']} ({c['raised_eur_m']}m)" for c in over[:15]))


if __name__ == "__main__":
    main()
