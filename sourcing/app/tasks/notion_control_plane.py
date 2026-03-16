"""Ensure Notion control plane and reconcile source intake."""

import asyncio

import structlog

from app.database import async_session_factory
from app.services.job_queue import enqueue_agent_job
from app.services.notion_control import ensure_control_plane, reconcile_source_registry
from app.models import Source
from sqlalchemy import select

logger = structlog.get_logger()


async def run_notion_control_plane() -> None:
    logger.info("notion_control_plane_starting")
    async with async_session_factory() as db:
        resources = await ensure_control_plane(db)
        reconciled = await reconcile_source_registry(db)

        sources = list(
            (
                await db.execute(
                    select(Source).where(
                        Source.onboarding_status.in_(["new", "queued", "bootstrap_pending"])
                    )
                )
            ).scalars().all()
        )
        enqueued = 0
        for source in sources:
            created = await enqueue_agent_job(
                db,
                job_type="source_onboarder",
                payload={"source_id": source.id, "trigger": "notion-control-plane"},
                external_ref=f"source:{source.id}:onboard",
                source_id=source.id,
                priority=10,
            )
            if created is not None:
                enqueued += 1

        await db.commit()

    logger.info(
        "notion_control_plane_complete",
        control_plane=len(resources),
        reconciled=reconciled,
        enqueued=enqueued,
    )


if __name__ == "__main__":
    structlog.configure(
        processors=[
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.dev.ConsoleRenderer(),
        ],
    )
    asyncio.run(run_notion_control_plane())
