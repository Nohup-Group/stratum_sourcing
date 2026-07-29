"""Read API for the sourcing console (password-gated).

The console frontend proxies /api/console/* here through its Caddy service, so
no CORS configuration is needed. Auth is a shared password sent as the
X-Console-Key header; endpoints refuse everything when CONSOLE_PASSWORD is
unset.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

import structlog
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_session
from app.config import settings
from app.models import (
    Entity,
    EntityMention,
    EntityResearchSnapshot,
    EntityScore,
    Finding,
    ScanRun,
    Signal,
    SignalResult,
    SignalScan,
    Source,
)
from app.services.signal_engine import enqueue_signal_scan

logger = structlog.get_logger()
router = APIRouter(prefix="/api/console")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


async def verify_console_key(
    x_console_key: str | None = Header(default=None, alias="X-Console-Key"),
) -> None:
    if not settings.console_password:
        raise HTTPException(status_code=503, detail="Console access is not configured")
    if not x_console_key or not secrets.compare_digest(
        x_console_key, settings.console_password
    ):
        raise HTTPException(status_code=401, detail="Invalid console key")


protected = Depends(verify_console_key)


# --- Serialization helpers ---


def _scan_summary(scan: SignalScan | None) -> dict | None:
    if scan is None:
        return None
    return {
        "id": scan.id,
        "status": scan.status,
        "scan_depth": scan.scan_depth,
        "trigger": scan.trigger,
        "score_pct": scan.score_pct,
        "band": scan.band,
        "points_earned": scan.points_earned,
        "points_possible": scan.points_possible,
        "signals_confirmed": scan.signals_confirmed,
        "signals_absent": scan.signals_absent,
        "signals_unknown": scan.signals_unknown,
        "signals_not_applicable": scan.signals_not_applicable,
        # Coverage is shown next to the score, never folded into it. A scan that
        # resolved 8% of the library is not a moderate company.
        "coverage": scan.coverage,
        "veto_flags": scan.veto_flags or [],
        "category_scores": scan.category_scores or {},
        "rationale": scan.rationale,
        "completed_at": scan.completed_at,
        "created_at": scan.created_at,
    }


def _entity_summary(entity: Entity) -> dict:
    return {
        "id": entity.id,
        "display_name": entity.display_name,
        "canonical_url": entity.canonical_url,
        "description": entity.description,
        "thesis_tags": entity.thesis_tags or [],
        "first_seen_at": entity.first_seen_at,
        "last_seen_at": entity.last_seen_at,
        "finding_count": entity.finding_count,
        "source_count": entity.source_count,
        "domain": entity.domain,
        "is_eligible": entity.is_eligible,
        "lifecycle_status": entity.lifecycle_status,
        "gate": entity.gate or {},
    }


async def _latest_scans_by_entity(
    db: AsyncSession, entity_ids: list[int]
) -> dict[int, SignalScan]:
    if not entity_ids:
        return {}
    stmt = (
        select(SignalScan)
        .where(
            SignalScan.entity_id.in_(entity_ids),
            SignalScan.status == "completed",
        )
        .order_by(SignalScan.entity_id, SignalScan.created_at.desc())
        .distinct(SignalScan.entity_id)
    )
    scans = (await db.execute(stmt)).scalars().all()
    return {scan.entity_id: scan for scan in scans}


# --- Auth check (used by the login screen) ---


@router.get("/auth/check", dependencies=[protected])
async def auth_check():
    return {"status": "ok"}


# --- Overview / funnel ---


@router.get("/overview", dependencies=[protected])
async def overview(db: AsyncSession = Depends(get_session)):
    week_ago = utc_now() - timedelta(days=7)

    sources_by_category = dict(
        (await db.execute(
            select(Source.category, func.count(Source.id))
            .where(Source.is_active.is_(True))
            .group_by(Source.category)
        )).all()
    )
    findings_total = (await db.execute(select(func.count(Finding.id)))).scalar_one()
    findings_week = (
        await db.execute(
            select(func.count(Finding.id)).where(Finding.created_at >= week_ago)
        )
    ).scalar_one()
    companies_total = (
        await db.execute(
            select(func.count(Entity.id)).where(Entity.entity_type == "company")
        )
    ).scalar_one()
    people_total = (
        await db.execute(
            select(func.count(Entity.id)).where(Entity.entity_type == "person")
        )
    ).scalar_one()
    companies_week = (
        await db.execute(
            select(func.count(Entity.id)).where(
                Entity.entity_type == "company", Entity.first_seen_at >= week_ago
            )
        )
    ).scalar_one()

    # Band distribution over each company's latest completed scan
    latest_scan_sq = (
        select(SignalScan.entity_id, SignalScan.band)
        .where(SignalScan.status == "completed")
        .order_by(SignalScan.entity_id, SignalScan.created_at.desc())
        .distinct(SignalScan.entity_id)
        .subquery()
    )
    bands = dict(
        (await db.execute(
            select(latest_scan_sq.c.band, func.count())
            .group_by(latest_scan_sq.c.band)
        )).all()
    )

    # Attribution: how many companies each source category has surfaced
    attribution = dict(
        (await db.execute(
            select(Source.category, func.count(func.distinct(EntityMention.entity_id)))
            .join(EntityMention, EntityMention.source_id == Source.id)
            .join(Entity, Entity.id == EntityMention.entity_id)
            .where(Entity.entity_type == "company")
            .group_by(Source.category)
        )).all()
    )

    runs = (
        (await db.execute(
            select(ScanRun).order_by(ScanRun.started_at.desc()).limit(14)
        ))
        .scalars()
        .all()
    )

    return {
        "sources": {
            "total": sum(sources_by_category.values()),
            "by_category": sources_by_category,
        },
        "findings": {"total": findings_total, "last_7_days": findings_week},
        "companies": {"total": companies_total, "new_last_7_days": companies_week},
        "people": {"total": people_total},
        "scans": {
            "companies_scanned": sum(bands.values()),
            "bands": bands,
        },
        "attribution": attribution,
        "recent_runs": [
            {
                "id": run.id,
                "started_at": run.started_at,
                "finished_at": run.finished_at,
                "status": run.status,
                "sources_total": run.sources_total,
                "sources_ok": run.sources_ok,
                "sources_failed": run.sources_failed,
                "findings_count": run.findings_count,
            }
            for run in runs
        ],
    }


# --- Companies ---


@router.get("/companies", dependencies=[protected])
async def list_companies(
    q: str | None = None,
    band: str | None = None,
    scanned_only: bool = False,
    eligible_only: bool = False,
    limit: int = 50,
    offset: int = 0,
    db: AsyncSession = Depends(get_session),
):
    stmt: Select = (
        select(Entity, EntityScore.score)
        .outerjoin(EntityScore, EntityScore.entity_id == Entity.id)
        .where(Entity.entity_type == "company")
    )
    if eligible_only:
        stmt = stmt.where(Entity.is_eligible.is_(True))
    if q:
        stmt = stmt.where(Entity.display_name.ilike(f"%{q}%"))
    stmt = stmt.order_by(EntityScore.score.desc().nulls_last()).limit(500)
    rows = (await db.execute(stmt)).all()

    entity_ids = [entity.id for entity, _ in rows]
    latest_scans = await _latest_scans_by_entity(db, entity_ids)

    items = []
    for entity, heuristic_score in rows:
        scan = latest_scans.get(entity.id)
        if scanned_only and scan is None:
            continue
        if band and (scan is None or scan.band != band):
            continue
        items.append(
            {
                **_entity_summary(entity),
                "triage_score": heuristic_score,
                "latest_scan": _scan_summary(scan),
            }
        )

    # Eligible first, then scanned (by scan score), then the rest by triage.
    # Ineligible companies stay visible as context but can never outrank a
    # company the fund could actually invest in.
    items.sort(
        key=lambda item: (
            item["is_eligible"] is True,
            item["latest_scan"] is not None,
            item["latest_scan"]["score_pct"] if item["latest_scan"] else 0.0,
            item["triage_score"] or 0.0,
        ),
        reverse=True,
    )
    return {"total": len(items), "items": items[offset : offset + limit]}


@router.get("/companies/{entity_id}", dependencies=[protected])
async def company_detail(
    entity_id: int,
    db: AsyncSession = Depends(get_session),
):
    entity = await db.get(Entity, entity_id)
    if entity is None or entity.entity_type != "company":
        raise HTTPException(status_code=404, detail="Company not found")

    heuristic = (
        await db.execute(select(EntityScore).where(EntityScore.entity_id == entity_id))
    ).scalar_one_or_none()

    research = (
        await db.execute(
            select(EntityResearchSnapshot)
            .where(EntityResearchSnapshot.entity_id == entity_id)
            .order_by(EntityResearchSnapshot.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    scans = (
        (await db.execute(
            select(SignalScan)
            .where(SignalScan.entity_id == entity_id)
            .order_by(SignalScan.created_at.desc())
            .limit(12)
        ))
        .scalars()
        .all()
    )
    latest_completed = next((s for s in scans if s.status == "completed"), None)

    results = []
    if latest_completed is not None:
        result_rows = (
            await db.execute(
                select(SignalResult, Signal)
                .join(Signal, Signal.id == SignalResult.signal_id)
                .where(SignalResult.scan_id == latest_completed.id)
                .order_by(Signal.number)
            )
        ).all()
        results = [
            {
                "number": signal.number,
                "category": signal.category,
                "subcategory": signal.subcategory,
                "name": signal.name,
                "strength": signal.strength,
                "is_veto": signal.is_veto,
                "result": result.result,
                "evidence_url": result.evidence_url,
                "note": result.note,
                "points_earned": result.points_earned,
                "points_possible": signal.points,
            }
            for result, signal in result_rows
        ]

    findings = (
        (await db.execute(
            select(Finding)
            .join(EntityMention, EntityMention.finding_id == Finding.id)
            .where(EntityMention.entity_id == entity_id)
            .options(selectinload(Finding.evidence_items), selectinload(Finding.source))
            .order_by(Finding.created_at.desc())
            .limit(12)
        ))
        .scalars()
        .unique()
        .all()
    )

    return {
        **_entity_summary(entity),
        "metadata": entity.metadata_ or {},
        "heuristic": (
            {
                "score": heuristic.score,
                "components": heuristic.components,
                "last_scored_at": heuristic.last_scored_at,
            }
            if heuristic
            else None
        ),
        "research_summary": research.summary if research else None,
        "latest_scan": _scan_summary(latest_completed),
        "scan_results": results,
        "scan_history": [_scan_summary(s) for s in scans],
        "recent_findings": [
            {
                "id": finding.id,
                "title": finding.title,
                "summary": finding.summary,
                "category": finding.category,
                "relevance_score": finding.relevance_score,
                "source": finding.source.name if finding.source else None,
                "created_at": finding.created_at,
                "evidence": [
                    {"url": ev.url, "excerpt": ev.excerpt}
                    for ev in finding.evidence_items[:3]
                ],
            }
            for finding in findings
        ],
    }


class ScanRequest(BaseModel):
    scan_depth: str = "standard"
    force: bool = False


@router.post("/companies/{entity_id}/scan", dependencies=[protected])
async def request_scan(
    entity_id: int,
    body: ScanRequest,
    db: AsyncSession = Depends(get_session),
):
    entity = await db.get(Entity, entity_id)
    if entity is None or entity.entity_type != "company":
        raise HTTPException(status_code=404, detail="Company not found")
    if body.scan_depth not in ("standard", "full"):
        raise HTTPException(status_code=422, detail="scan_depth must be standard or full")

    job = await enqueue_signal_scan(
        db,
        entity_id=entity_id,
        scan_depth=body.scan_depth,
        trigger="manual",
        force=body.force,
    )
    if job is None:
        return {"status": "skipped", "reason": "recent scan exists (use force to rescan)"}
    return {"status": "queued", "job_id": job.id}


# --- Picks ---


@router.get("/picks", dependencies=[protected])
async def weekly_picks(
    limit: int = 10,
    db: AsyncSession = Depends(get_session),
):
    latest_scan_sq = (
        select(SignalScan.id)
        .where(SignalScan.status == "completed")
        .order_by(SignalScan.entity_id, SignalScan.created_at.desc())
        .distinct(SignalScan.entity_id)
        .subquery()
    )
    scans = (
        (await db.execute(
            select(SignalScan)
            .where(SignalScan.id.in_(select(latest_scan_sq.c.id)))
            .options(selectinload(SignalScan.entity))
            .order_by(SignalScan.score_pct.desc())
            .limit(limit)
        ))
        .scalars()
        .all()
    )

    scan_ids = [scan.id for scan in scans]
    highlights: dict[int, list[dict]] = {}
    if scan_ids:
        highlight_rows = (
            await db.execute(
                select(SignalResult.scan_id, Signal.name, SignalResult.evidence_url)
                .join(Signal, Signal.id == SignalResult.signal_id)
                .where(
                    SignalResult.scan_id.in_(scan_ids),
                    SignalResult.result == "confirmed",
                    Signal.strength == "high",
                )
                .order_by(Signal.number)
            )
        ).all()
        for scan_id, name, evidence_url in highlight_rows:
            highlights.setdefault(scan_id, [])
            if len(highlights[scan_id]) < 4:
                highlights[scan_id].append({"name": name, "evidence_url": evidence_url})

    picks = [
        {
            "rank": rank,
            "entity": _entity_summary(scan.entity),
            "scan": _scan_summary(scan),
            "highlights": highlights.get(scan.id, []),
        }
        for rank, scan in enumerate(scans, start=1)
    ]

    # Leads worth scanning next. This list is NOT a ranking of thesis fit —
    # triage_score is derived from the articles that mention a company, so it
    # measures salience. It used to be presented as a score and surfaced
    # Anthropic, Revolut and Coinbase as the fund's top suggestions. Companies
    # that failed the eligibility gate are excluded outright.
    scanned_ids = [scan.entity_id for scan in scans]
    rising_stmt = (
        select(Entity, EntityScore.score)
        .join(EntityScore, EntityScore.entity_id == Entity.id)
        .where(
            Entity.entity_type == "company",
            Entity.is_eligible.isnot(False),
            Entity.lifecycle_status.notin_(("acquired", "dissolved")),
        )
        .order_by(EntityScore.score.desc())
        .limit(limit * 3)
    )
    rising = [
        {**_entity_summary(entity), "triage_score": score}
        for entity, score in (await db.execute(rising_stmt)).all()
        if entity.id not in scanned_ids
    ][:5]

    return {
        "picks": picks,
        "rising_unscanned": rising,
        "rising_note": (
            "Triage only — ranks how prominent a lead is in our sources, not "
            "thesis fit. Only a signal scan measures fit."
        ),
    }


# --- Signal library ---


@router.get("/signals", dependencies=[protected])
async def list_signals(db: AsyncSession = Depends(get_session)):
    signals = (
        (await db.execute(select(Signal).order_by(Signal.number))).scalars().all()
    )
    confirm_counts = dict(
        (await db.execute(
            select(SignalResult.signal_id, func.count(SignalResult.id))
            .where(SignalResult.result == "confirmed")
            .group_by(SignalResult.signal_id)
        )).all()
    )
    return {
        "total": len(signals),
        "items": [
            {
                "number": s.number,
                "category": s.category,
                "subcategory": s.subcategory,
                "name": s.name,
                "indicator": s.indicator,
                "data_source": s.data_source,
                "strength": s.strength,
                "threshold": s.threshold,
                "anti_signal": s.anti_signal,
                "points": s.points,
                "scan_tier": s.scan_tier,
                "is_veto": s.is_veto,
                "times_confirmed": confirm_counts.get(s.id, 0),
            }
            for s in signals
        ],
    }


# --- Sources ---


@router.get("/sources", dependencies=[protected])
async def list_console_sources(db: AsyncSession = Depends(get_session)):
    sources = (
        (await db.execute(
            select(Source).where(Source.is_active.is_(True)).order_by(
                Source.category, Source.name
            )
        ))
        .scalars()
        .all()
    )
    return {
        "total": len(sources),
        "items": [
            {
                "id": s.id,
                "name": s.name,
                "category": s.category,
                "url": s.url,
                "fetch_strategy": s.fetch_strategy,
                "cadence_bucket": s.cadence_bucket,
                "last_ingested_at": s.last_ingested_at,
                "onboarding_status": s.onboarding_status,
                "discovery_mode": s.discovery_mode,
            }
            for s in sources
        ],
    }
