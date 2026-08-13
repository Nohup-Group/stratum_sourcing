"""The agent-jobs cron crashed on every 10-minute run on 2026-08-12.

An entity_extractor job wrote a 101-character role_hint into
entity_mentions.role_hint VARCHAR(80). Postgres raised
StringDataRightTruncationError — and then the handler in run_agent_job_cycle
died on its own logging call, because it never rolled the session back and
reading job.id re-queried a poisoned transaction (PendingRollbackError). The
exception left the cycle, the container exited non-zero, and Railway reported
"Deploy Crashed". mark_job_failed never ran, so the job kept its attempt count
and the next cron run claimed the same poison pill again.

Two properties are locked in here:

1. a role hint longer than 80 characters persists intact;
2. a job whose DB write fails for *any* reason does not take the cycle with
   it — it is marked for retry, its attempt count advances, and the remaining
   jobs in the same cycle still run.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import Text, select, text

from app.database import async_session_factory, engine
from app.models import AgentJob, EntityMention, Finding, ScanRun, Source
from app.services import agent_pipeline

REPO_ROOT = Path(__file__).resolve().parents[1]
TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "")

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not TEST_DATABASE_URL,
        reason="needs a scratch Postgres — set TEST_DATABASE_URL",
    ),
]

# The exact value from the crash: 101 characters into a VARCHAR(80).
LONG_ROLE_HINT = (
    "NEAR cofounder making the case for staking-funded AI inference "
    "and cryptographic proof for AI outputs"
)

# Longer than entity_mentions.mention_text / entities.display_name (both 255),
# so the job fails inside the DB the way the production job did.
OVERSIZED_NAME = "Ω" + "a" * 300


@pytest.fixture(scope="session", autouse=True)
def migrated_database() -> None:
    """Schema comes from the migrations, not from Base.metadata.create_all.

    The defect being fixed lives in a migration, and migrations are what the
    container runs on boot. Building the schema from the models instead would
    pass even with the migration missing.
    """
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=REPO_ROOT,
        check=True,
        env={**os.environ, "DATABASE_URL": TEST_DATABASE_URL},
        capture_output=True,
    )


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
    # The pool binds connections to the loop that opened them, and each test
    # gets a fresh loop.
    await engine.dispose()


async def seed_extractor_job(*, title: str, dedup_hash: str) -> tuple[int, int]:
    """One source, one finding, one pending entity_extractor job for it."""
    async with async_session_factory() as db:
        source = Source(
            name=f"Test Source {dedup_hash}",
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
            title=title,
            summary=(
                "NEAR cofounder Illia Polosukhin says staking can fund AI inference, "
                "with NEAR AI Cloud, IronClaw and Intents in one economy."
            ),
            dedup_hash=dedup_hash,
        )
        db.add(finding)
        await db.flush()

        job = AgentJob(
            job_type="entity_extractor",
            source_id=source.id,
            payload={"finding_ids": [finding.id], "source_id": source.id},
        )
        db.add(job)
        await db.commit()
        return job.id, finding.id


def stub_extractor(by_finding_id: dict[int, list[dict]]):
    """Replace the LLM call, keyed on the finding it was called for."""

    async def _run(*, caller: str = "", **_kwargs) -> dict:
        finding_id = int(caller.rsplit("_", 1)[-1])
        return {"entities": by_finding_id[finding_id]}

    return _run


async def test_a_role_hint_longer_than_80_chars_persists(monkeypatch) -> None:
    assert len(LONG_ROLE_HINT) > 80, "this test is meaningless below the old limit"
    # The row below persists on the migration's DDL alone — SQLAlchemy does not
    # enforce String lengths on write — so the model has to be asserted
    # separately or it can drift back to String(80) unnoticed.
    assert isinstance(EntityMention.__table__.c.role_hint.type, Text)

    job_id, finding_id = await seed_extractor_job(
        title="NEAR pitches staking-funded AI inference",
        dedup_hash="hash-long-role-hint",
    )
    monkeypatch.setattr(
        agent_pipeline,
        "run_ops_json_prompt",
        stub_extractor(
            {
                finding_id: [
                    {
                        "name": "Illia Polosukhin",
                        "entity_type": "person",
                        "role_hint": LONG_ROLE_HINT,
                        "confidence": 0.97,
                    }
                ]
            }
        ),
    )

    result = await agent_pipeline.run_agent_job_cycle(limit=5, lease_owner="test")

    assert result["processed_jobs"] == 1
    assert result["failed_jobs"] == 0

    async with async_session_factory() as db:
        job = await db.get(AgentJob, job_id)
        assert job.status == "completed"
        mention = (await db.execute(select(EntityMention))).scalars().one()
        assert mention.role_hint == LONG_ROLE_HINT


async def test_a_failing_job_does_not_take_the_cycle_down(monkeypatch) -> None:
    poisoned_job_id, poisoned_finding_id = await seed_extractor_job(
        title="Finding whose extraction cannot be written",
        dedup_hash="hash-poisoned",
    )
    healthy_job_id, healthy_finding_id = await seed_extractor_job(
        title="Finding that must still be processed",
        dedup_hash="hash-healthy",
    )
    monkeypatch.setattr(
        agent_pipeline,
        "run_ops_json_prompt",
        stub_extractor(
            {
                poisoned_finding_id: [
                    {"name": OVERSIZED_NAME, "entity_type": "company", "confidence": 0.9}
                ],
                healthy_finding_id: [
                    {"name": "Anthropic", "entity_type": "company", "confidence": 0.9}
                ],
            }
        ),
    )

    result = await agent_pipeline.run_agent_job_cycle(limit=5, lease_owner="test")

    assert result["failed_jobs"] == 1
    assert result["processed_jobs"] == 1

    async with async_session_factory() as db:
        poisoned = await db.get(AgentJob, poisoned_job_id)
        assert poisoned.status == "retry"
        # Without a durable claim the rollback would undo the increment too,
        # and the job would never reach the dead-letter threshold.
        assert poisoned.attempts == 1
        assert poisoned.last_error
        assert poisoned.lease_owner is None

        healthy = await db.get(AgentJob, healthy_job_id)
        assert healthy.status == "completed"

        mentions = (await db.execute(select(EntityMention))).scalars().all()
        assert [m.mention_text for m in mentions] == ["Anthropic"]
