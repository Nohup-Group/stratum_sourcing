"""FastAPI routes: health, sources CRUD, task triggers."""

import asyncio
import hashlib

import structlog
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_session, verify_cron_secret
from app.models import Entity, Finding, Source, WatchTarget
from app.schemas import (
    EntityResponse,
    FindingResponse,
    HealthResponse,
    SourceCreate,
    SourceResponse,
    TaskTriggerResponse,
    WatchTargetResponse,
)
from app.services.job_queue import enqueue_agent_job, enqueue_event
from app.services.notion_control import (
    get_webhook_token,
    parse_webhook_body,
    reconcile_source_registry,
    remember_webhook_token,
    verify_webhook_signature,
)

logger = structlog.get_logger()
router = APIRouter()


# --- Health ---


@router.get("/healthz", response_model=HealthResponse)
async def healthz():
    return HealthResponse(status="ok")


# --- Sources ---


@router.get("/api/sources", response_model=list[SourceResponse])
async def list_sources(
    category: str | None = None,
    active_only: bool = True,
    db: AsyncSession = Depends(get_session),
):
    stmt = select(Source)
    if active_only:
        stmt = stmt.where(Source.is_active.is_(True))
    if category:
        stmt = stmt.where(Source.category == category)
    stmt = stmt.order_by(Source.category, Source.name)
    result = await db.execute(stmt)
    return result.scalars().all()


@router.post("/api/sources", response_model=SourceResponse, status_code=201)
async def create_source(
    source: SourceCreate,
    db: AsyncSession = Depends(get_session),
):
    db_source = Source(**source.model_dump())
    db.add(db_source)
    await db.flush()
    await enqueue_agent_job(
        db,
        job_type="source_onboarder",
        payload={"source_id": db_source.id, "trigger": "api"},
        external_ref=f"source:{db_source.id}:onboard",
        source_id=db_source.id,
        priority=10,
    )
    await db.refresh(db_source)
    return db_source


# --- Findings ---


@router.get("/api/findings", response_model=list[FindingResponse])
async def list_findings(
    limit: int = 20,
    status: str | None = None,
    db: AsyncSession = Depends(get_session),
):
    stmt = select(Finding).options(selectinload(Finding.evidence_items)).order_by(Finding.relevance_score.desc()).limit(limit)
    if status:
        stmt = stmt.where(Finding.status == status)
    result = await db.execute(stmt)
    return result.scalars().all()


@router.get("/api/findings/search")
async def search_findings(
    q: str,
    limit: int = 10,
    db: AsyncSession = Depends(get_session),
):
    """Search findings by text (used by Lexie Q&A)."""
    from sqlalchemy import and_

    # Split query into words so "JPMorgan tokenized" matches findings containing both
    words = q.strip().split()
    word_filters = [
        Finding.title.ilike(f"%{w}%") | Finding.summary.ilike(f"%{w}%")
        for w in words
        if w
    ]
    stmt = (
        select(Finding)
        .options(selectinload(Finding.evidence_items))
        .where(and_(*word_filters) if word_filters else Finding.id > 0)
        .order_by(Finding.relevance_score.desc())
        .limit(limit)
    )
    result = await db.execute(stmt)
    findings = result.scalars().all()
    return [FindingResponse.model_validate(f) for f in findings]


@router.get("/api/entities", response_model=list[EntityResponse])
async def list_entities(
    entity_type: str | None = None,
    limit: int = 100,
    db: AsyncSession = Depends(get_session),
):
    stmt = select(Entity).order_by(Entity.last_seen_at.desc()).limit(limit)
    if entity_type:
        stmt = stmt.where(Entity.entity_type == entity_type)
    result = await db.execute(stmt)
    return result.scalars().all()


@router.get("/api/watchlist", response_model=list[WatchTargetResponse])
async def list_watch_targets(
    target_type: str | None = None,
    limit: int = 100,
    db: AsyncSession = Depends(get_session),
):
    stmt = (
        select(WatchTarget)
        .options(selectinload(WatchTarget.entity))
        .order_by(WatchTarget.target_type.asc(), WatchTarget.score.desc())
        .limit(limit)
    )
    if target_type:
        stmt = stmt.where(WatchTarget.target_type == target_type)
    result = await db.execute(stmt)
    return result.scalars().all()


# --- Notion webhook ---


@router.post("/webhooks/notion/source-registry")
async def notion_source_registry_webhook(
    request: Request,
    x_notion_signature: str | None = Header(default=None, alias="X-Notion-Signature"),
    db: AsyncSession = Depends(get_session),
):
    body = await request.body()
    payload = parse_webhook_body(body)

    verification_token = payload.get("verification_token") or payload.get("verificationToken")
    if verification_token and not x_notion_signature:
        await remember_webhook_token(db, str(verification_token))
        logger.info("notion_webhook_token_recorded")
        return {"status": "ok", "mode": "verification"}

    webhook_token = await get_webhook_token(db)
    if webhook_token:
        if not verify_webhook_signature(body, x_notion_signature or "", webhook_token):
            raise HTTPException(status_code=403, detail="Invalid Notion webhook signature")
    else:
        raise HTTPException(status_code=503, detail="Notion webhook verification token not configured")

    event_key = hashlib.sha256(body).hexdigest()
    await enqueue_event(
        db,
        event_type="notion_source_registry_webhook",
        payload=payload,
        dedup_key=f"notion_webhook:{event_key}",
    )
    reconciled = await reconcile_source_registry(db)

    sources_stmt = select(Source).where(
        Source.onboarding_status.in_(["new", "queued", "bootstrap_pending"])
    )
    sources = list((await db.execute(sources_stmt)).scalars().all())
    enqueued = 0
    for source in sources:
        created = await enqueue_agent_job(
            db,
            job_type="source_onboarder",
            payload={"source_id": source.id, "trigger": "notion-webhook"},
            external_ref=f"source:{source.id}:onboard",
            source_id=source.id,
            priority=10,
        )
        if created is not None:
            enqueued += 1

    logger.info("notion_source_registry_webhook_processed", reconciled=reconciled, enqueued=enqueued)
    return {"status": "ok", "reconciled": reconciled, "enqueued": enqueued}


# --- Task triggers (called by Railway cron or manual) ---


@router.post("/tasks/nightly-scan", response_model=TaskTriggerResponse)
async def trigger_nightly_scan(
    _secret: str = Depends(verify_cron_secret),
):
    from app.tasks.nightly_scan import run_nightly_scan

    asyncio.create_task(run_nightly_scan())
    return TaskTriggerResponse(status="accepted", message="Nightly scan started")


@router.post("/tasks/morning-digest", response_model=TaskTriggerResponse)
async def trigger_morning_digest(
    _secret: str = Depends(verify_cron_secret),
):
    from app.tasks.morning_digest import run_morning_digest

    asyncio.create_task(run_morning_digest())
    return TaskTriggerResponse(status="accepted", message="Morning digest started")


@router.post("/tasks/notion-sync", response_model=TaskTriggerResponse)
async def trigger_notion_sync(
    _secret: str = Depends(verify_cron_secret),
):
    from app.tasks.notion_export import run_notion_sync

    asyncio.create_task(run_notion_sync())
    return TaskTriggerResponse(status="accepted", message="Notion sync started")


@router.post("/tasks/notion-control-plane", response_model=TaskTriggerResponse)
async def trigger_notion_control_plane(
    _secret: str = Depends(verify_cron_secret),
):
    from app.tasks.notion_control_plane import run_notion_control_plane

    asyncio.create_task(run_notion_control_plane())
    return TaskTriggerResponse(status="accepted", message="Notion control plane sync started")


@router.post("/tasks/agent-jobs", response_model=TaskTriggerResponse)
async def trigger_agent_jobs(
    _secret: str = Depends(verify_cron_secret),
):
    from app.tasks.agent_jobs import run_agent_jobs

    asyncio.create_task(run_agent_jobs())
    return TaskTriggerResponse(status="accepted", message="Agent jobs started")


@router.post("/tasks/cadence-scan", response_model=TaskTriggerResponse)
async def trigger_cadence_scan(
    _secret: str = Depends(verify_cron_secret),
):
    from app.tasks.cadence_scan import run_cadence_scan

    asyncio.create_task(run_cadence_scan())
    return TaskTriggerResponse(status="accepted", message="Cadence scan started")


@router.post("/admin/reset-findings")
async def reset_findings(
    _secret: str = Depends(verify_cron_secret),
    db: AsyncSession = Depends(get_session),
):
    """Clear all findings, evidence, notifications, snapshots, and scan runs."""
    from sqlalchemy import text

    await db.execute(text("DELETE FROM notifications"))
    await db.execute(text("DELETE FROM evidence"))
    await db.execute(text("DELETE FROM findings"))
    await db.execute(text("DELETE FROM snapshots"))
    await db.execute(text("DELETE FROM scan_runs"))
    await db.commit()
    logger.info("admin_reset_findings")
    return {"status": "ok", "message": "All findings, snapshots, and scan runs cleared"}
