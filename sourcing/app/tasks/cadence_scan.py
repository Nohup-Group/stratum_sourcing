"""Cadence-based source scan worker."""

import asyncio
import os

import structlog

from app.pipeline.orchestrator import run_due_scan

logger = structlog.get_logger()


async def run_cadence_scan() -> None:
    cadence_bucket = os.getenv("CADENCE_BUCKET") or None
    limit_raw = os.getenv("CADENCE_LIMIT")
    limit = int(limit_raw) if limit_raw else None
    logger.info("cadence_scan_starting", cadence_bucket=cadence_bucket, limit=limit)
    run_id = await asyncio.wait_for(
        run_due_scan(cadence_bucket=cadence_bucket, limit=limit),
        timeout=1800,
    )
    logger.info("cadence_scan_complete", run_id=run_id, cadence_bucket=cadence_bucket)


if __name__ == "__main__":
    structlog.configure(
        processors=[
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.dev.ConsoleRenderer(),
        ],
    )
    asyncio.run(run_cadence_scan())
