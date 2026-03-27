"""Main scan orchestrator: iterates sources, fetches content, produces findings.

Follows the ncf-dataroom multi-stage pipeline pattern with per-source error isolation,
bounded concurrency, and stage-level tracking for observability.
"""

import asyncio
import time
from datetime import datetime, timedelta, timezone

import structlog
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import async_session_factory
from app.models import ScanRun, Snapshot, Source
from app.pipeline.analyzer import analyze_diff
from app.pipeline.deduplicator import clear_embedding_cache, is_duplicate, is_semantic_duplicate
from app.pipeline.differ import compute_diff, split_blocks
from app.pipeline.prefilter import dedup_blocks_against_findings, filter_blocks
from app.pipeline.scorer import score_finding
from app.pipeline.tracker import PipelineTracker, ScanStage
from app.services.job_queue import enqueue_event
from app.services.source_pipeline import compute_next_ingest_at
from app.sources.registry import close_all_fetchers, get_fetcher

logger = structlog.get_logger()


async def run_scan(
    *,
    due_only: bool = False,
    cadence_bucket: str | None = None,
    limit: int | None = None,
) -> int:
    """Execute a scan over active or due sources.

    Returns:
        The scan_run ID.
    """
    now = datetime.now(timezone.utc)
    async with async_session_factory() as db:
        # Create scan run record
        run = ScanRun(
            started_at=now,
            metadata_={
                "mode": "due" if due_only else "full",
                "cadence_bucket": cadence_bucket,
                "limit": limit,
            },
        )
        db.add(run)
        await db.flush()
        run_id = run.id

        stmt = select(Source).where(Source.is_active.is_(True))
        if due_only:
            stmt = stmt.where(
                or_(Source.next_ingest_at.is_(None), Source.next_ingest_at <= now),
                or_(Source.cooldown_until.is_(None), Source.cooldown_until <= now),
                Source.onboarding_status.notin_(["paused", "error"]),
            )
        if cadence_bucket:
            stmt = stmt.where(Source.cadence_bucket == cadence_bucket)
        stmt = stmt.order_by(Source.next_ingest_at.asc().nullsfirst(), Source.id.asc())
        if limit:
            stmt = stmt.limit(limit)

        result = await db.execute(stmt)
        sources = result.scalars().all()
        run.sources_total = len(sources)
        await db.commit()

    logger.info("scan_started", run_id=run_id, sources=len(sources))

    # Process sources with bounded concurrency
    semaphore = asyncio.Semaphore(settings.fetch_concurrency)
    errors: list[dict] = []
    ok_count = 0
    findings_count = 0

    async def process_source(source: Source) -> None:
        nonlocal ok_count, findings_count
        async with semaphore:
            try:
                count = await _scan_single_source(source, run_id)
                ok_count += 1
                findings_count += count
            except Exception as e:
                logger.error(
                    "source_scan_failed",
                    source_id=source.id,
                    source_name=source.name,
                    error=str(e),
                )
                errors.append({
                    "source_id": source.id,
                    "source_name": source.name,
                    "error": str(e),
                })

    # Run all sources concurrently (bounded by semaphore)
    await asyncio.gather(
        *(process_source(s) for s in sources),
        return_exceptions=True,
    )

    # Clean up resources
    await close_all_fetchers()
    clear_embedding_cache()

    # Update scan run with results
    async with async_session_factory() as db:
        run = await db.get(ScanRun, run_id)
        run.finished_at = datetime.now(timezone.utc)
        run.status = "completed_with_errors" if errors else "completed"
        run.sources_ok = ok_count
        run.sources_failed = len(errors)
        run.findings_count = findings_count
        run.error_log = errors
        await db.commit()

    logger.info(
        "scan_completed",
        run_id=run_id,
        ok=ok_count,
        failed=len(errors),
        findings=findings_count,
    )
    return run_id


async def run_due_scan(cadence_bucket: str | None = None, limit: int | None = None) -> int:
    """Execute a scan for due sources only."""
    return await run_scan(due_only=True, cadence_bucket=cadence_bucket, limit=limit)


async def _scan_single_source(source: Source, run_id: int) -> int:
    """Scan a single source: fetch → diff → analyze → score → dedup → store.

    Each stage is tracked via PipelineTracker for observability (ncf pattern).

    Returns:
        Number of new findings created.
    """
    tracker = PipelineTracker(run_id=run_id, source_id=source.id, source_name=source.name)
    fetcher = get_fetcher(source.fetch_strategy)

    if not source.url:
        logger.info("source_no_url", source_id=source.id, name=source.name)
        return 0

    # --- Stage: FETCH ---
    tracker.start(ScanStage.FETCH)
    t0 = time.monotonic()
    result = await fetcher.fetch(source.url, source.config)
    fetch_ms = int((time.monotonic() - t0) * 1000)

    async with async_session_factory() as db:
        # Store snapshot regardless of success/failure
        snapshot = Snapshot(
            source_id=source.id,
            run_id=run_id,
            content_hash=result.content_hash or "",
            raw_content=result.content if not result.error else None,
            fetched_at=result.fetched_at,
            fetch_duration_ms=result.duration_ms,
            error=result.error,
            metadata_=result.metadata or {},
        )
        db.add(snapshot)
        await db.flush()

        source_row = await db.get(Source, source.id)
        assert source_row is not None

        if result.error:
            tracker.fail(ScanStage.FETCH, error=result.error)
            source_row.onboarding_status = "error"
            source_row.cooldown_until = datetime.now(timezone.utc) + timedelta(hours=6)
            source_row.next_ingest_at = compute_next_ingest_at(source_row)
            await db.commit()
            return 0

        tracker.complete(ScanStage.FETCH, duration_ms=fetch_ms)
        source_row.last_ingested_at = result.fetched_at
        source_row.next_ingest_at = compute_next_ingest_at(source_row, from_time=result.fetched_at)
        source_row.cooldown_until = None
        source_row.onboarding_status = "active"

        # --- Stage: DIFF ---
        tracker.start(ScanStage.DIFF)
        t0 = time.monotonic()
        diff_text = await compute_diff(db, source.id, result.content_hash, result.content, run_id=run_id)
        diff_ms = int((time.monotonic() - t0) * 1000)

        if not diff_text:
            tracker.complete(ScanStage.DIFF, duration_ms=diff_ms, details={"changed": False})
            await db.commit()
            return 0

        # Skip LLM if the diff is too small to contain a real finding
        MIN_DIFF_CHARS = 200
        if len(diff_text) < MIN_DIFF_CHARS:
            tracker.complete(ScanStage.DIFF, duration_ms=diff_ms, details={"changed": True, "skipped": True, "chars": len(diff_text)})
            logger.info("diff_too_small", source_id=source.id, name=source.name, chars=len(diff_text))
            await db.commit()
            return 0

        tracker.complete(ScanStage.DIFF, duration_ms=diff_ms, details={"changed": True, "chars": len(diff_text)})

        # --- Stage: PREFILTER (embedding-based relevance check) ---
        tracker.start(ScanStage.PREFILTER)
        t0 = time.monotonic()
        blocks = split_blocks(diff_text)
        if blocks:
            filtered_blocks, filter_stats = await filter_blocks(blocks)
            if filtered_blocks:
                diff_text = "\n\n---\n\n".join(filtered_blocks)
            else:
                # All blocks below threshold — skip LLM entirely
                prefilter_ms = int((time.monotonic() - t0) * 1000)
                tracker.complete(ScanStage.PREFILTER, duration_ms=prefilter_ms, details=filter_stats)
                logger.info("prefilter_all_dropped", source_id=source.id, name=source.name, **filter_stats)
                await db.commit()
                return 0
        else:
            filter_stats = {"skipped": True, "reason": "no_blocks"}
        prefilter_ms = int((time.monotonic() - t0) * 1000)
        tracker.complete(ScanStage.PREFILTER, duration_ms=prefilter_ms, details=filter_stats)

        # --- Pre-analysis dedup: skip blocks that match recent findings ---
        blocks_for_dedup = split_blocks(diff_text)
        if blocks_for_dedup:
            novel_blocks, dedup_stats = await dedup_blocks_against_findings(
                db, blocks_for_dedup, source.id,
            )
            if not novel_blocks:
                logger.info("pre_dedup_all_known", source_id=source.id, name=source.name, **dedup_stats)
                await db.commit()
                return 0
            if len(novel_blocks) < len(blocks_for_dedup):
                diff_text = "\n\n---\n\n".join(novel_blocks)

        # --- Stage: ANALYZE (LLM, per-category prompt) ---
        tracker.start(ScanStage.ANALYZE)
        t0 = time.monotonic()
        raw_findings = await analyze_diff(
            diff_text=diff_text,
            source_name=source.name,
            source_category=source.category,
            source_url=source.url,
        )
        analyze_ms = int((time.monotonic() - t0) * 1000)
        tracker.complete(
            ScanStage.ANALYZE,
            duration_ms=analyze_ms,
            details={"raw_findings": len(raw_findings)},
        )

        # --- Stage: SCORE + DEDUP + STORE ---
        tracker.start(ScanStage.STORE)
        t0 = time.monotonic()
        new_count = 0
        dupes = 0
        finding_ids: list[int] = []

        for raw in raw_findings:
            # Score (applies vertical alignment, geographic, stage, authority weights)
            scored = score_finding(raw, source)

            # Dedup layer 1: exact hash (same title + source + date)
            if await is_duplicate(db, scored["dedup_hash"]):
                dupes += 1
                continue

            # Dedup layer 2: semantic similarity (same news from different sources)
            if await is_semantic_duplicate(
                db, scored["title"], scored["summary"], source.id
            ):
                dupes += 1
                continue

            from app.models import Evidence, Finding

            finding = Finding(
                run_id=run_id,
                source_id=source.id,
                title=scored["title"],
                summary=scored["summary"],
                category=scored.get("category"),
                relevance_score=scored["relevance_score"],
                vertical_tags=scored.get("vertical_tags", []),
                metadata_={
                    "published_date": scored.get("published_date"),
                    "entities": scored.get("entities", []),
                    "raw_relevance_score": raw.get("relevance_score"),
                },
                dedup_hash=scored["dedup_hash"],
            )
            db.add(finding)
            await db.flush()
            finding_ids.append(finding.id)

            # Store evidence items
            for ev in scored.get("evidence", []):
                evidence = Evidence(
                    finding_id=finding.id,
                    url=ev.get("url", source.url),
                    excerpt=ev.get("excerpt", ""),
                    captured_at=result.fetched_at,
                )
                db.add(evidence)

            new_count += 1

        if finding_ids:
            await enqueue_event(
                db,
                event_type="snapshot_ready",
                payload={
                    "run_id": run_id,
                    "source_id": source.id,
                    "snapshot_id": snapshot.id,
                    "finding_ids": finding_ids,
                },
                dedup_key=f"snapshot_ready:{snapshot.id}",
                source_id=source.id,
            )

        await db.commit()
        store_ms = int((time.monotonic() - t0) * 1000)
        tracker.complete(
            ScanStage.STORE,
            duration_ms=store_ms,
            details={"new": new_count, "duplicates": dupes},
        )

    logger.info(
        "source_scanned",
        source_id=source.id,
        name=source.name,
        new_findings=new_count,
        duplicates=dupes,
        stages=tracker.to_dict()["stages"],
    )
    return new_count
