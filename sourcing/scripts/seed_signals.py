"""Seed the signal library from seeds/signal_library.json.

Idempotent — re-running updates existing signals in place.

Usage:
    DATABASE_URL="postgresql://..." .venv/bin/python -m scripts.seed_signals
"""

import asyncio
import json
from pathlib import Path

from app.database import async_session_factory
from app.services.signal_engine import seed_signals

LIBRARY_PATH = Path(__file__).resolve().parent.parent / "seeds" / "signal_library.json"


async def main() -> None:
    library = json.loads(LIBRARY_PATH.read_text())
    async with async_session_factory() as db:
        result = await seed_signals(db, library)
        await db.commit()
    tier1 = sum(result["tier1_by_category"].values())
    print(
        f"Seeded {result['created']} new / {result['updated']} updated signals "
        f"({tier1}+ in tier 1): {result['tier1_by_category']}"
    )


if __name__ == "__main__":
    asyncio.run(main())
