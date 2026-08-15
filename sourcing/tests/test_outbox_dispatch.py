"""The outbox side of the crash that took agent-jobs down on 2026-08-12/13.

The job loop in run_agent_job_cycle was given per-item isolation after one bad
row killed a whole cycle. dispatch_outbox_events never got the same treatment:
its per-event loop has no try/except and never commits per event, so a single
event whose handling raises aborts the batch before anything is written. Every
co-batched event is rolled back with it — including healthy ones whose jobs had
already been created in memory — and the exception escapes the cycle, exits the
container, and comes back on the next cron tick.

A non-dict payload is enough to trigger it: `payload.get("entity_type")` at
job_queue.py raises AttributeError on a list.

Two properties are locked in here:

1. one poisoned event does not discard the healthy events claimed alongside it;
2. the poisoned event's attempt count advances and it reaches a terminal state,
   so it cannot be re-claimed forever.
"""

from __future__ import annotations

import os

import pytest
from sqlalchemy import select, text

from app.database import async_session_factory, engine
from app.models import AgentJob, EventOutbox, Finding, ScanRun, Source
from app.services import agent_pipeline, job_queue

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "")

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not TEST_DATABASE_URL,
        reason="needs a scratch Postgres — set TEST_DATABASE_URL",
    ),
]

# `payload = event.payload or {}` keeps a list as-is, and the entity_candidate
# branch then calls .get() on it.
POISON_PAYLOAD = ["not", "a", "dict"]


@pytest.fixture(autouse=True)
async def clean_tables() -> None:
    async with async_session_factory() as db:
        await db.execute(
            text(
                "TRUNCATE entity_mentions, entities, agent_jobs, event_outbox, "
                "evidence, findings, scan_runs, sources RESTART IDENTITY CASCADE"
            )
        )
        await db.commit()
    yield
    await engine.dispose()


async def seed_poisoned_then_healthy() -> tuple[int, int, int]:
    """A poisoned event ordered ahead of a healthy one in the same batch.

    claim_pending_events orders by created_at, so the poison is handled first —
    on the pre-fix code the healthy event is never reached at all.
    """
    async with async_session_factory() as db:
        source = Source(
            name="Outbox Test Source",
            category="newsletter",
            fetch_strategy="rss",
            url="https://example.com/feed",
        )
        run = ScanRun(status="completed")
        db.add_all([source, run])
        await db.flush()

        finding = Finding(
            run_id=run.id,
            source_id=source.id,
            title="A finding the healthy event points at",
            summary="Franklin Templeton received SEC staff relief to hold FOBXX.",
            dedup_hash="hash-outbox-healthy",
        )
        db.add(finding)
        await db.flush()

        poisoned = EventOutbox(
            event_type="entity_candidate",
            payload=POISON_PAYLOAD,
            source_id=source.id,
        )
        db.add(poisoned)
        await db.flush()

        healthy = EventOutbox(
            event_type="snapshot_ready",
            payload={"finding_ids": [finding.id], "source_id": source.id},
            source_id=source.id,
        )
        db.add(healthy)
        await db.commit()
        return poisoned.id, healthy.id, finding.id


def stub_extractor(finding_id: int):
    async def _run(**_kwargs) -> dict:
        return {
            "entities": [
                {"name": "Franklin Templeton", "entity_type": "company", "confidence": 0.9}
            ]
        }

    return _run


async def test_a_poisoned_event_does_not_discard_the_batch(monkeypatch) -> None:
    poisoned_id, healthy_id, finding_id = await seed_poisoned_then_healthy()
    monkeypatch.setattr(agent_pipeline, "run_ops_json_prompt", stub_extractor(finding_id))

    result = await agent_pipeline.run_agent_job_cycle(limit=25, lease_owner="test")

    # The healthy event must have produced a job, and that job must have run in
    # the same cycle — this is what the pre-fix code throws away.
    assert result["dispatched_events"] == 1
    assert result["processed_jobs"] == 1

    async with async_session_factory() as db:
        healthy = await db.get(EventOutbox, healthy_id)
        assert healthy.status == "dispatched"

        jobs = (await db.execute(select(AgentJob))).scalars().all()
        assert [j.job_type for j in jobs] == ["entity_extractor"]
        assert jobs[0].status == "completed"


async def test_a_poisoned_event_advances_and_dead_letters(monkeypatch) -> None:
    poisoned_id, healthy_id, finding_id = await seed_poisoned_then_healthy()
    monkeypatch.setattr(agent_pipeline, "run_ops_json_prompt", stub_extractor(finding_id))

    await agent_pipeline.run_agent_job_cycle(limit=25, lease_owner="test")

    async with async_session_factory() as db:
        poisoned = await db.get(EventOutbox, poisoned_id)
        # Not silently dropped, not stuck mid-flight, and not re-claimable
        # forever: the attempt count is what eventually dead-letters it.
        assert poisoned.attempts == 1
        assert poisoned.status in {"pending", "failed"}
        assert poisoned.last_error

    # Four more cycles must exhaust it rather than retrying without end.
    for _ in range(4):
        async with async_session_factory() as db:
            event = await db.get(EventOutbox, poisoned_id)
            if event.status == "failed":
                break
            event.available_at = event.created_at
            await db.commit()
        await agent_pipeline.run_agent_job_cycle(limit=25, lease_owner="test")

    async with async_session_factory() as db:
        poisoned = await db.get(EventOutbox, poisoned_id)
        assert poisoned.status == "failed", "a poison event must dead-letter, not loop"


async def test_a_database_error_in_a_handler_does_not_kill_the_dispatcher(monkeypatch) -> None:
    """The poison above is an AttributeError raised before any DB write, so it
    never actually poisons the session — it cannot prove the recovery path.
    A *database* error is what left the session unusable in production, and it
    is the only thing that exercises the rollback.
    """
    poisoned_id, healthy_id, finding_id = await seed_poisoned_then_healthy()

    async with async_session_factory() as db:
        # Make the first event well-formed so it reaches the DB write; the
        # failure is injected there instead.
        poisoned = await db.get(EventOutbox, poisoned_id)
        poisoned.payload = {"entity_type": "company"}
        await db.commit()

    real_enqueue = job_queue.enqueue_agent_job

    async def failing_enqueue(db, **kwargs):
        if kwargs.get("event_id") == poisoned_id:
            await db.execute(text("SELECT 1 / 0"))
        return await real_enqueue(db, **kwargs)

    monkeypatch.setattr(job_queue, "enqueue_agent_job", failing_enqueue)
    monkeypatch.setattr(agent_pipeline, "run_ops_json_prompt", stub_extractor(finding_id))

    result = await agent_pipeline.run_agent_job_cycle(limit=25, lease_owner="test")

    assert result["dispatched_events"] == 1
    assert result["processed_jobs"] == 1

    async with async_session_factory() as db:
        assert (await db.get(EventOutbox, healthy_id)).status == "dispatched"
        failed = await db.get(EventOutbox, poisoned_id)
        assert failed.attempts == 1
        assert failed.last_error


async def seed_one_healthy_event() -> tuple[int, int]:
    async with async_session_factory() as db:
        source = Source(
            name="Lease Test Source",
            category="newsletter",
            fetch_strategy="rss",
            url="https://example.com/lease",
        )
        run = ScanRun(status="completed")
        db.add_all([source, run])
        await db.flush()
        finding = Finding(
            run_id=run.id,
            source_id=source.id,
            title="Lease test finding",
            summary="A summary.",
            dedup_hash="hash-lease",
        )
        db.add(finding)
        await db.flush()
        event = EventOutbox(
            event_type="snapshot_ready",
            payload={"finding_ids": [finding.id], "source_id": source.id},
            source_id=source.id,
        )
        db.add(event)
        await db.commit()
        return event.id, finding.id


async def test_a_freshly_claimed_event_is_protected_by_its_lease() -> None:
    """The negative half of the reclaim. Without it a zero-length lease — which
    is what a naive `updated_at` produces on any host that is not UTC — reads as
    working, and two dispatchers process the same event concurrently.
    """
    event_id, _ = await seed_one_healthy_event()

    async with async_session_factory() as first:
        claimed = await job_queue.claim_pending_events(first, limit=25)
        assert [e.id for e in claimed] == [event_id]
        await first.commit()

        async with async_session_factory() as second:
            stolen = await job_queue.claim_pending_events(second, limit=25)
            await second.commit()

    assert stolen == [], "a second dispatcher must not steal a live lease"

    async with async_session_factory() as db:
        event = await db.get(EventOutbox, event_id)
        assert event.attempts == 0, "a claim is not a delivery attempt"


async def strand_once(event_id: int) -> None:
    """Claim the event, commit, die, then wind its lease into the past."""
    async with async_session_factory() as db:
        await job_queue.claim_pending_events(db, limit=25)
        await db.commit()
    async with async_session_factory() as db:
        await db.execute(
            text("UPDATE event_outbox SET available_at = now() - interval '1 minute' WHERE id = :i"),
            {"i": event_id},
        )
        await db.commit()


async def test_being_stranded_does_not_spend_the_retry_budget(monkeypatch) -> None:
    """A dispatcher dying is not the event's fault.

    When the claim incremented `attempts`, three strandings left a perfectly
    good event with zero retries, and its first transient error dead-lettered
    it for good — permanently, because every producer uses a stable dedup_key
    and enqueue_event does on_conflict_do_nothing, so nothing can recreate it.
    Three strandings is not hypothetical: it is what the 2026-08-12 crash loop
    did every 45 minutes.
    """
    poisoned_id, _, finding_id = await seed_poisoned_then_healthy()

    for _ in range(3):
        await strand_once(poisoned_id)

    async with async_session_factory() as db:
        assert (await db.get(EventOutbox, poisoned_id)).attempts == 0

    monkeypatch.setattr(agent_pipeline, "run_ops_json_prompt", stub_extractor(finding_id))
    await agent_pipeline.run_agent_job_cycle(limit=25, lease_owner="test")

    async with async_session_factory() as db:
        event = await db.get(EventOutbox, poisoned_id)
        assert event.attempts == 1, "only the handler failure counts"
        assert event.status == "pending", "one real failure must not be terminal"


async def test_an_event_stranded_by_a_dead_dispatcher_is_reclaimed(monkeypatch) -> None:
    """The claim is committed before handlers run, so a process that dies
    mid-batch leaves events in "processing". Nothing re-selected that state
    before, which would have stranded them permanently.

    The lease is taken through the real claim path, not written by hand, so
    this also covers however `claim_pending_events` chooses to record it.
    """
    event_id, finding_id = await seed_one_healthy_event()
    monkeypatch.setattr(agent_pipeline, "run_ops_json_prompt", stub_extractor(finding_id))

    async with async_session_factory() as db:
        await job_queue.claim_pending_events(db, limit=25)
        await db.commit()  # dispatcher claims, then dies here

    async with async_session_factory() as db:
        event = await db.get(EventOutbox, event_id)
        assert event.status == "processing"
        # Wind the lease into the past rather than sleeping 45 minutes.
        await db.execute(
            text("UPDATE event_outbox SET available_at = now() - interval '1 minute' WHERE id = :i"),
            {"i": event_id},
        )
        await db.commit()

    result = await agent_pipeline.run_agent_job_cycle(limit=25, lease_owner="test")

    assert result["dispatched_events"] == 1, "a stranded event must be picked back up"
    async with async_session_factory() as db:
        assert (await db.get(EventOutbox, event_id)).status == "dispatched"


async def test_the_claim_is_durable_before_any_handler_runs(monkeypatch) -> None:
    """A rollback mid-batch must not un-claim the events beside it.

    The claim is committed before the first handler for this reason. Without
    that commit the suite still passes — one poison event's rollback silently
    returns its co-batched siblings to `pending`, and a concurrent dispatcher
    can claim and dispatch them again while this one is still working. The
    window is invisible from the final state, so it is observed from inside
    the batch.
    """
    poisoned_id, healthy_id, finding_id = await seed_poisoned_then_healthy()
    monkeypatch.setattr(agent_pipeline, "run_ops_json_prompt", stub_extractor(finding_id))

    seen: dict[str, list[int]] = {}
    real_dispatch = job_queue._dispatch_one_event

    async def observing_dispatch(db, event):
        # By the time the healthy event is handled, the poison has already
        # failed and rolled back. A second dispatcher must find nothing.
        if event.id == healthy_id:
            async with async_session_factory() as rival:
                stolen = await job_queue.claim_pending_events(rival, limit=25)
                seen["stolen"] = [e.id for e in stolen]
                await rival.rollback()
        return await real_dispatch(db, event)

    monkeypatch.setattr(job_queue, "_dispatch_one_event", observing_dispatch)

    await agent_pipeline.run_agent_job_cycle(limit=25, lease_owner="test")

    assert seen.get("stolen") == [], (
        "a second dispatcher claimed events this one still held — the rollback "
        "un-claimed the batch"
    )


async def test_dispatch_counts_and_statuses_are_unchanged() -> None:
    """Behaviour preservation for the branch logic extracted into
    _dispatch_one_event: an unknown type is ignored and counts 0, a terminal
    watchlist event is dispatched and counts 1.
    """
    async with async_session_factory() as db:
        db.add_all(
            [
                EventOutbox(event_type="watchlist_update_ready", payload={}),
                EventOutbox(event_type="something_nobody_handles", payload={}),
            ]
        )
        await db.commit()

    async with async_session_factory() as db:
        dispatched = await job_queue.dispatch_outbox_events(db, limit=25)

    assert dispatched == 1
    async with async_session_factory() as db:
        rows = (await db.execute(select(EventOutbox).order_by(EventOutbox.id))).scalars().all()
        assert [(r.event_type, r.status) for r in rows] == [
            ("watchlist_update_ready", "dispatched"),
            ("something_nobody_handles", "ignored"),
        ]
