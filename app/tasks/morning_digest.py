"""Morning digest task entry point."""

import asyncio

import structlog

from app.integrations.slack_bot import send_morning_digest

logger = structlog.get_logger()


async def run_morning_digest() -> None:
    """Send the morning Slack digest."""
    logger.info("morning_digest_starting")
    try:
        sent = await send_morning_digest()
        if sent:
            logger.info("morning_digest_sent")
        else:
            logger.info("morning_digest_skipped")
    except Exception as e:
        logger.error("morning_digest_failed", error=str(e))
        raise


if __name__ == "__main__":
    structlog.configure(
        processors=[
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.dev.ConsoleRenderer(),
        ],
    )
    asyncio.run(run_morning_digest())
