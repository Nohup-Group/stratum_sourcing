"""Import local scan data (exported JSON) into the database.

Usage:
    DATABASE_URL="postgresql://..." .venv/bin/python -m scripts.import_scan_data local_scan_export_v2.json
"""

import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

from app.database import async_session_factory
from app.models import Evidence, Finding, ScanRun, Source


def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    return datetime.fromisoformat(s)


async def import_data(path: str) -> None:
    data = json.loads(Path(path).read_text())

    async with async_session_factory() as db:
        # Build source name -> id mapping from target DB
        sources = (await db.execute(select(Source))).scalars().all()
        name_to_id = {s.name: s.id for s in sources}
        print(f"Found {len(name_to_id)} sources in target DB")

        # Create scan run
        run = ScanRun(
            started_at=datetime.now(timezone.utc),
            finished_at=datetime.now(timezone.utc),
            status="imported",
        )
        db.add(run)
        await db.flush()
        run_id = run.id
        print(f"Created scan run {run_id}")

        # Import findings
        imported = 0
        skipped = 0
        for f in data["findings"]:
            source_id = name_to_id.get(f["source_name"])
            if not source_id:
                skipped += 1
                continue

            finding = Finding(
                run_id=run_id,
                source_id=source_id,
                title=f["title"],
                summary=f["summary"],
                category=f.get("category"),
                relevance_score=f["relevance_score"],
                vertical_tags=f.get("vertical_tags", []),
                status=f.get("status", "new"),
                dedup_hash=f["dedup_hash"],
            )
            db.add(finding)
            await db.flush()

            for ev in f.get("evidence", []):
                evidence = Evidence(
                    finding_id=finding.id,
                    url=ev["url"],
                    excerpt=ev.get("excerpt", ""),
                    captured_at=_parse_dt(ev.get("captured_at")),
                )
                db.add(evidence)

            imported += 1

        run.findings_count = imported
        await db.commit()
        print(f"Imported {imported} findings, skipped {skipped} (source not found)")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python -m scripts.import_scan_data <export.json>")
        sys.exit(1)
    asyncio.run(import_data(sys.argv[1]))
