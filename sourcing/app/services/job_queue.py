"""Durable event and agent-job helpers."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import structlog
from sqlalchemy import Select, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AgentJob, EventOutbox, IntegrationState

logger = structlog.get_logger()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


async def get_integration_state(
    db: AsyncSession,
    integration: str,
) -> IntegrationState | None:
    result = await db.execute(
        select(IntegrationState).where(IntegrationState.integration == integration)
    )
    return result.scalar_one_or_none()


async def upsert_integration_state(
    db: AsyncSession,
    integration: str,
    config: dict,
) -> IntegrationState:
    stmt = (
        insert(IntegrationState)
        .values(integration=integration, config=config)
        .on_conflict_do_update(
            index_elements=["integration"],
            set_={"config": config, "updated_at": utc_now()},
        )
        .returning(IntegrationState.id)
    )
    result = await db.execute(stmt)
    state_id = result.scalar_one()
    state = await db.get(IntegrationState, state_id)
    assert state is not None
    return state


async def enqueue_event(
    db: AsyncSession,
    *,
    event_type: str,
    payload: dict,
    dedup_key: str | None = None,
    source_id: int | None = None,
    entity_id: int | None = None,
    available_at: datetime | None = None,
) -> EventOutbox | None:
    values = {
        "event_type": event_type,
        "payload": payload,
        "dedup_key": dedup_key,
        "source_id": source_id,
        "entity_id": entity_id,
        "available_at": available_at or utc_now(),
    }
    stmt = insert(EventOutbox).values(**values)
    if dedup_key:
        stmt = stmt.on_conflict_do_nothing(index_elements=["dedup_key"])
    stmt = stmt.returning(EventOutbox.id)
    result = await db.execute(stmt)
    event_id = result.scalar_one_or_none()
    if event_id is None:
        return None
    return await db.get(EventOutbox, event_id)


async def enqueue_agent_job(
    db: AsyncSession,
    *,
    job_type: str,
    payload: dict,
    external_ref: str | None = None,
    source_id: int | None = None,
    entity_id: int | None = None,
    event_id: int | None = None,
    priority: int = 100,
    available_at: datetime | None = None,
) -> AgentJob | None:
    values = {
        "job_type": job_type,
        "payload": payload,
        "external_ref": external_ref,
        "source_id": source_id,
        "entity_id": entity_id,
        "event_id": event_id,
        "priority": priority,
        "available_at": available_at or utc_now(),
    }
    stmt = insert(AgentJob).values(**values)
    if external_ref:
        stmt = stmt.on_conflict_do_nothing(
            index_elements=["job_type", "external_ref"]
        )
    stmt = stmt.returning(AgentJob.id)
    result = await db.execute(stmt)
    job_id = result.scalar_one_or_none()
    if job_id is None:
        return None
    return await db.get(AgentJob, job_id)


async def claim_pending_events(db: AsyncSession, limit: int = 50) -> list[EventOutbox]:
    stmt: Select[tuple[EventOutbox]] = (
        select(EventOutbox)
        .where(
            EventOutbox.status == "pending",
            EventOutbox.available_at <= utc_now(),
        )
        .order_by(EventOutbox.created_at.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    result = await db.execute(stmt)
    events = list(result.scalars().all())
    for event in events:
        event.status = "processing"
        event.attempts += 1
    await db.flush()
    return events


async def claim_pending_jobs(
    db: AsyncSession,
    *,
    limit: int = 25,
    lease_owner: str,
) -> list[AgentJob]:
    stmt: Select[tuple[AgentJob]] = (
        select(AgentJob)
        .where(
            AgentJob.status.in_(["pending", "retry"]),
            AgentJob.available_at <= utc_now(),
        )
        .order_by(AgentJob.priority.asc(), AgentJob.created_at.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    result = await db.execute(stmt)
    jobs = list(result.scalars().all())
    lease_time = utc_now()
    for job in jobs:
        job.status = "running"
        job.leased_at = lease_time
        job.lease_owner = lease_owner
        job.attempts += 1
    await db.flush()
    return jobs


async def mark_job_failed(
    db: AsyncSession,
    job: AgentJob,
    *,
    error: str,
    retry: bool = True,
) -> None:
    attempts = max(job.attempts, 1)
    job.last_error = error[:4000]
    job.status = "retry" if retry else "failed"
    job.available_at = utc_now() + timedelta(minutes=min(attempts * 5, 60))
    job.leased_at = None
    job.lease_owner = None
    await db.flush()


async def dispatch_outbox_events(db: AsyncSession, limit: int = 50) -> int:
    events = await claim_pending_events(db, limit=limit)
    dispatched = 0

    for event in events:
        payload = event.payload or {}
        created_job = None

        if event.event_type == "snapshot_ready":
            created_job = await enqueue_agent_job(
                db,
                job_type="entity_extractor",
                payload=payload,
                external_ref=f"event:{event.id}",
                source_id=event.source_id,
                event_id=event.id,
                priority=20,
            )
        elif event.event_type == "entity_candidate":
            job_type = (
                "company_researcher"
                if payload.get("entity_type") == "company"
                else "people_researcher"
            )
            created_job = await enqueue_agent_job(
                db,
                job_type=job_type,
                payload=payload,
                external_ref=f"event:{event.id}",
                source_id=event.source_id,
                entity_id=event.entity_id,
                event_id=event.id,
                priority=30,
            )
        elif event.event_type == "entity_profile_ready":
            created_job = await enqueue_agent_job(
                db,
                job_type="entity_scorer",
                payload=payload,
                external_ref=f"event:{event.id}",
                source_id=event.source_id,
                entity_id=event.entity_id,
                event_id=event.id,
                priority=40,
            )
        elif event.event_type == "source_expansion_candidate":
            created_job = await enqueue_agent_job(
                db,
                job_type="source_expander",
                payload=payload,
                external_ref=f"event:{event.id}",
                source_id=event.source_id,
                entity_id=event.entity_id,
                event_id=event.id,
                priority=50,
            )
        elif event.event_type == "watchlist_update_ready":
            event.status = "dispatched"
            dispatched += 1
            continue

        event.status = "dispatched" if created_job is not None else "ignored"
        if created_job is not None:
            dispatched += 1

    await db.flush()
    return dispatched
