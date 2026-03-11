"""Nightly scan task entry point."""

import asyncio
import sys

import structlog

from app.pipeline.orchestrator import run_scan

logger = structlog.get_logger()


async def run_nightly_scan() -> None:
    """Execute the full nightly scan pipeline."""
    logger.info("nightly_scan_starting")
    try:
        run_id = await run_scan()
        logger.info("nightly_scan_complete", run_id=run_id)
    except Exception as e:
        logger.error("nightly_scan_failed", error=str(e))
        raise


if __name__ == "__main__":
    structlog.configure(
        processors=[
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.dev.ConsoleRenderer(),
        ],
    )
    asyncio.run(run_nightly_scan())
