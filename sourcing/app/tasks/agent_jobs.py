"""Agent worker task entry point."""

import asyncio

import structlog

from app.services.agent_pipeline import run_agent_job_cycle

logger = structlog.get_logger()


async def run_agent_jobs(limit: int = 25) -> None:
    logger.info("agent_jobs_starting", limit=limit)
    result = await asyncio.wait_for(run_agent_job_cycle(limit=limit), timeout=900)
    logger.info("agent_jobs_complete", **result)


if __name__ == "__main__":
    structlog.configure(
        processors=[
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.dev.ConsoleRenderer(),
        ],
    )
    asyncio.run(run_agent_jobs())
