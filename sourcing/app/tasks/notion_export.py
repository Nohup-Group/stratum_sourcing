"""Notion sync task entry point."""

import asyncio

import structlog

from app.integrations.notion_sync import run_full_notion_sync

logger = structlog.get_logger()


async def run_notion_sync() -> None:
    """Sync control-plane databases, watchlists, and findings to Notion."""
    logger.info("notion_sync_starting")
    try:
        result = await asyncio.wait_for(run_full_notion_sync(), timeout=900)
        logger.info("notion_sync_complete", **result)

    except asyncio.TimeoutError:
        logger.error("notion_sync_timeout", msg="Task exceeded timeout")
    except Exception as e:
        logger.error("notion_sync_failed", error=str(e))
        raise


if __name__ == "__main__":
    structlog.configure(
        processors=[
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.dev.ConsoleRenderer(),
        ],
    )
    asyncio.run(run_notion_sync())
