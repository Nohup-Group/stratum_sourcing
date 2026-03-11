"""Notion sync task entry point."""

import asyncio

import structlog

from app.integrations.notion_sync import pull_status_updates, sync_findings_to_notion

logger = structlog.get_logger()


async def run_notion_sync() -> None:
    """Sync findings to Notion and pull status updates back."""
    logger.info("notion_sync_starting")
    try:
        # Push new findings to Notion
        synced = await sync_findings_to_notion()
        logger.info("notion_push_complete", synced=synced)

        # Pull status changes from Notion
        updated = await pull_status_updates()
        logger.info("notion_pull_complete", updated=updated)

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
