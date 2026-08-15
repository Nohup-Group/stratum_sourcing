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
    now = utc_now()
    stmt: Select[tuple[EventOutbox]] = (
        select(EventOutbox)
        .where(
            ((EventOutbox.status == "pending") & (EventOutbox.available_at <= now))
            # Reclaim events whose dispatcher died mid-batch. The claim is
            # committed before any handler runs, so without this they would sit
            # in "processing" forever. The lease rides on available_at, which is
            # always written explicitly with an aware datetime — updated_at is
            # populated by onupdate=datetime.utcnow, a NAIVE value on a
            # timezone-aware column, so it lands offset by the process's UTC
            # offset and the lease would expire instantly anywhere but UTC.
            | ((EventOutbox.status == "processing") & (EventOutbox.available_at <= now))
        )
        .order_by(EventOutbox.created_at.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    result = await db.execute(stmt)
    events = list(result.scalars().all())
    lease_expiry = now + timedelta(minutes=STALE_LEASE_MINUTES)
    for event in events:
        event.status = "processing"
        event.available_at = lease_expiry
    # attempts is deliberately NOT incremented here: a claim is not a delivery
    # attempt, and reclaiming an event after a dispatcher died would otherwise
    # spend the retry budget of an event no handler has ever touched. It is
    # counted in mark_event_failed instead.
    await db.flush()
    return events


STALE_LEASE_MINUTES = 45


async def claim_pending_jobs(
    db: AsyncSession,
    *,
    limit: int = 25,
    lease_owner: str,
) -> list[AgentJob]:
    stale_cutoff = utc_now() - timedelta(minutes=STALE_LEASE_MINUTES)
    stmt: Select[tuple[AgentJob]] = (
        select(AgentJob)
        .where(
            (
                AgentJob.status.in_(["pending", "retry"])
                & (AgentJob.available_at <= utc_now())
            )
            # Reclaim jobs whose worker died mid-run (lease never released)
            | ((AgentJob.status == "running") & (AgentJob.leased_at <= stale_cutoff))
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


MAX_EVENT_ATTEMPTS = 4


async def mark_event_failed(db: AsyncSession, event: EventOutbox, *, error: str) -> None:
    # The one place a delivery attempt is counted. Dead-lettering is terminal:
    # every producer passes a stable dedup_key and enqueue_event does
    # on_conflict_do_nothing, so a failed event can never be recreated.
    event.attempts += 1
    event.last_error = error[:4000]
    event.status = "pending" if event.attempts < MAX_EVENT_ATTEMPTS else "failed"
    event.available_at = utc_now() + timedelta(minutes=min(event.attempts * 5, 60))
    await db.flush()


async def _dispatch_one_event(db: AsyncSession, event: EventOutbox) -> int:
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
        return 1

    event.status = "dispatched" if created_job is not None else "ignored"
    await db.flush()
    return 1 if created_job is not None else 0


async def dispatch_outbox_events(db: AsyncSession, limit: int = 50) -> int:
    events = await claim_pending_events(db, limit=limit)
    # Durable before any handler runs, for the same reason the job claim is:
    # a handler that poisons the transaction is rolled back below, and an
    # uncommitted claim would roll back with it — attempts would never advance
    # and a poison event would be re-dispatched forever.
    await db.commit()
    dispatched = 0

    for event_id in [event.id for event in events]:
        # Reloaded per iteration, and its fields held as plain values: the
        # rollback below expires every object in the session.
        event = await db.get(EventOutbox, event_id)
        if event is None:
            # Deleted between the committed claim and here — scripts/ does
            # delete outbox rows. Nothing to dispatch and nothing to record.
            continue
        event_type = event.event_type
        try:
            dispatched += await _dispatch_one_event(db, event)
        except Exception as error:
            await db.rollback()
            logger.exception(
                "outbox_event_failed", event_id=event_id, event_type=event_type
            )
            event = await db.get(EventOutbox, event_id)
            if event is not None:
                await mark_event_failed(db, event, error=str(error))
        await db.commit()

    return dispatched
