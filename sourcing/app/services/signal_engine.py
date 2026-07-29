"""Signal engine: seed the Stratum3 library, run company scans, compute scores.

Implements the framework from Stratum3_200_Observable_Signals.xlsx:
- 200 observable signals in 7 categories, High (2 pts) / Medium (1 pt)
- Per-company scans marking each signal confirmed / absent / unknown (Y/N/?),
  unknown earns half credit
- Score bands: >=70% strong, 50-69% moderate, 35-49% weak, <35% insufficient
- Veto signals (licensing / AML / adverse action): an absent verdict flags the
  scan for review regardless of total score — it does not zero the score
- Standard scans cover tier-1 signals (~60 highest-leverage); full scans cover
  all 200. LLM calls are batched (settings.signal_scan_batch_size signals per
  call) to keep token cost bounded.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import structlog
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings
from app.models import (
    AgentJob,
    Entity,
    EntityResearchSnapshot,
    Finding,
    Signal,
    SignalResult,
    SignalScan,
    WatchTarget,
)
from app.services.job_queue import enqueue_agent_job, enqueue_event
from app.services.ops_client import run_ops_json_prompt

logger = structlog.get_logger()

def utc_now() -> datetime:
    return datetime.now(timezone.utc)

STRENGTH_POINTS = {"high": 2.0, "medium": 1.0}

# Per-category tier-1 quotas (~60 signals for the standard scan). Within each
# category the first N high-strength signals in library order are tier 1.
TIER1_QUOTAS = {
    "Founder & Team": 12,
    "Technology & Product": 9,
    "Regulatory & Compliance": 10,
    "Commercial Traction": 9,
    "Investor & Funding": 8,
    "Market Presence": 6,
    "Structural & Strategic": 6,
}

# Playbook step 5: N on licensing (if operating regulated activity), AML
# framework, or adverse regulatory/enforcement action means review regardless
# of total score.
VETO_SIGNAL_NUMBERS = {81, 82, 83, 84, 90, 93, 109, 155}

BAND_THRESHOLDS = (
    (0.70, "strong"),
    (0.50, "moderate"),
    (0.35, "weak"),
)


def band_for(score_pct: float) -> str:
    for threshold, band in BAND_THRESHOLDS:
        if score_pct >= threshold:
            return band
    return "insufficient"


# ---------------------------------------------------------------------------
# Seeding
# ---------------------------------------------------------------------------


async def seed_signals(db: AsyncSession, library: list[dict]) -> dict:
    """Upsert the signal library. Idempotent — keyed on signal number."""
    existing = {
        s.number: s for s in (await db.execute(select(Signal))).scalars().all()
    }
    tier1_used: dict[str, int] = {}
    created = updated = 0

    for row in library:
        number = int(row["num"])
        category = row["category"].strip()
        strength = (row.get("strength") or "high").strip().lower()
        if strength not in STRENGTH_POINTS:
            strength = "medium"

        quota = TIER1_QUOTAS.get(category, 0)
        is_veto = number in VETO_SIGNAL_NUMBERS
        tier = 2
        if strength == "high" and tier1_used.get(category, 0) < quota:
            tier = 1
            tier1_used[category] = tier1_used.get(category, 0) + 1
        if is_veto:
            tier = 1  # veto signals are always checked

        values = {
            "category": category,
            "subcategory": (row.get("subcategory") or "").strip() or None,
            "name": row["name"].strip(),
            "indicator": (row.get("indicator") or "").strip() or None,
            "data_source": (row.get("data_source") or "").strip() or None,
            "search_method": (row.get("search_method") or "").strip() or None,
            "strength": strength,
            "threshold": (row.get("threshold") or "").strip() or None,
            "anti_signal": (row.get("anti_signal") or "").strip() or None,
            "points": STRENGTH_POINTS[strength],
            "scan_tier": tier,
            "is_veto": is_veto,
        }

        signal = existing.get(number)
        if signal is None:
            db.add(Signal(number=number, **values))
            created += 1
        else:
            for key, value in values.items():
                setattr(signal, key, value)
            updated += 1

    await db.flush()
    logger.info(
        "signals_seeded", created=created, updated=updated, tier1_by_category=tier1_used
    )
    return {"created": created, "updated": updated, "tier1_by_category": tier1_used}


# ---------------------------------------------------------------------------
# Scoring (pure — unit-testable without DB or LLM)
# ---------------------------------------------------------------------------

RESULT_CREDIT = {"confirmed": 1.0, "unknown": 0.5, "absent": 0.0}


def compute_scan_scoring(
    signals: list[Signal],
    results_by_number: dict[int, dict],
) -> dict:
    """Roll per-signal verdicts up to points, category scores, band, and vetoes.

    results_by_number: {signal.number: {"result": ..., "evidence_url": ..., "note": ...}}
    Signals with no verdict are treated as unknown.
    """
    per_signal: list[dict] = []
    categories: dict[str, dict] = {}
    earned = possible = 0.0
    counts = {"confirmed": 0, "absent": 0, "unknown": 0}
    veto_flags: list[dict] = []

    for signal in signals:
        verdict = results_by_number.get(signal.number) or {}
        result = verdict.get("result") or "unknown"
        if result not in RESULT_CREDIT:
            result = "unknown"
        signal_earned = signal.points * RESULT_CREDIT[result]

        earned += signal_earned
        possible += signal.points
        counts[result] += 1

        cat = categories.setdefault(
            signal.category,
            {"earned": 0.0, "possible": 0.0, "confirmed": 0, "absent": 0, "unknown": 0},
        )
        cat["earned"] += signal_earned
        cat["possible"] += signal.points
        cat[result] += 1

        if signal.is_veto and result == "absent":
            veto_flags.append(
                {
                    "number": signal.number,
                    "name": signal.name,
                    "note": (verdict.get("note") or "")[:300],
                }
            )

        per_signal.append(
            {
                "signal": signal,
                "result": result,
                "evidence_url": (verdict.get("evidence_url") or "").strip() or None,
                "note": (verdict.get("note") or "").strip() or None,
                "points_earned": round(signal_earned, 2),
            }
        )

    for cat in categories.values():
        cat["earned"] = round(cat["earned"], 2)
        cat["possible"] = round(cat["possible"], 2)
        cat["pct"] = round(cat["earned"] / cat["possible"], 4) if cat["possible"] else 0.0

    score_pct = round(earned / possible, 4) if possible else 0.0
    return {
        "per_signal": per_signal,
        "points_earned": round(earned, 2),
        "points_possible": round(possible, 2),
        "score_pct": score_pct,
        "band": band_for(score_pct),
        "category_scores": categories,
        "counts": counts,
        "veto_flags": veto_flags,
    }


# ---------------------------------------------------------------------------
# Scan job
# ---------------------------------------------------------------------------

SCAN_SYSTEM_PROMPT = """You are the signal-scan analyst for Stratum 3Ventures, a VC investing at Seed/Series A in European companies building regulated digital-finance infrastructure (identity & permissioning, wallets & key management, compliance & trust, data/oracles/middleware).

You receive one company and a batch of observable signals. For each signal decide:
- "Y" — public evidence meets the signal's positive threshold. Only answer Y when you can point to a specific, checkable fact; include the best URL you know for it.
- "N" — you are confident the signal is not present for this company.
- "?" — you cannot confirm or deny from the provided context and your knowledge. When unsure, answer "?", never guess Y.

Use the provided company context first. Use web research if you have tools for it; otherwise rely on the context and well-established knowledge. Never invent URLs, licences, customers, or partnerships.

Respond with ONLY a JSON object:
{"results": [{"n": <signal number>, "r": "Y"|"N"|"?", "url": "<evidence url or empty>", "note": "<max 25 words: the concrete fact, or why unknown>"}]}
Include every signal number you were given exactly once."""


def _trim(text: str | None, limit: int) -> str:
    if not text:
        return ""
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _signal_line(signal: Signal) -> str:
    parts = [f"#{signal.number} [{signal.category}] {signal.name}"]
    if signal.indicator:
        parts.append(f"look for: {_trim(signal.indicator, 180)}")
    if signal.threshold:
        parts.append(f"Y threshold: {_trim(signal.threshold, 140)}")
    if signal.anti_signal:
        parts.append(f"red flag: {_trim(signal.anti_signal, 100)}")
    return " | ".join(parts)


async def _company_context(db: AsyncSession, entity: Entity) -> str:
    research_stmt = (
        select(EntityResearchSnapshot)
        .where(EntityResearchSnapshot.entity_id == entity.id)
        .order_by(EntityResearchSnapshot.created_at.desc())
        .limit(1)
    )
    research = (await db.execute(research_stmt)).scalar_one_or_none()

    findings_stmt = (
        select(Finding)
        .join(Finding.entity_mentions)
        .where(Finding.entity_mentions.any(entity_id=entity.id))
        .options(selectinload(Finding.evidence_items))
        .order_by(Finding.relevance_score.desc())
        .limit(8)
    )
    findings = (await db.execute(findings_stmt)).scalars().all()

    lines = [f"Company: {entity.display_name}"]
    if entity.canonical_url:
        lines.append(f"Website: {entity.canonical_url}")
    if entity.thesis_tags:
        lines.append(f"Thesis tags: {', '.join(entity.thesis_tags)}")
    if entity.description:
        lines.append(f"Description: {_trim(entity.description, 600)}")
    if research is not None:
        lines.append(f"Research summary: {_trim(research.summary, 900)}")
        profile = research.profile or {}
        for key in ("founders", "funding", "customers", "partnerships", "regulatory"):
            if profile.get(key):
                lines.append(f"{key.capitalize()}: {_trim(json.dumps(profile[key]), 300)}")
    if findings:
        lines.append("Recent intelligence from our monitored sources:")
        for finding in findings:
            evidence_url = (
                finding.evidence_items[0].url if finding.evidence_items else ""
            )
            lines.append(
                f"- {_trim(finding.title, 120)}: {_trim(finding.summary, 200)}"
                + (f" [{evidence_url}]" if evidence_url else "")
            )
    return "\n".join(lines)


def _parse_batch_results(payload: dict) -> dict[int, dict]:
    verdict_map = {"y": "confirmed", "n": "absent", "?": "unknown"}
    parsed: dict[int, dict] = {}
    for item in payload.get("results") or []:
        try:
            number = int(item.get("n"))
        except (TypeError, ValueError):
            continue
        result = verdict_map.get(str(item.get("r", "?")).strip().lower(), "unknown")
        parsed[number] = {
            "result": result,
            "evidence_url": str(item.get("url") or "").strip(),
            "note": str(item.get("note") or "").strip(),
        }
    return parsed


async def process_signal_scan_job(db: AsyncSession, job: AgentJob) -> dict:
    payload = job.payload or {}
    entity_id = int(payload.get("entity_id") or job.entity_id)
    scan_depth = payload.get("scan_depth") or "standard"
    trigger = payload.get("trigger") or "manual"

    entity = await db.get(Entity, entity_id)
    if entity is None:
        return {"entity_id": entity_id, "skipped": True, "reason": "entity_missing"}
    if entity.entity_type != "company":
        return {"entity_id": entity_id, "skipped": True, "reason": "not_a_company"}

    # Reuse the scan row across retries of the same job
    scan_stmt = select(SignalScan).where(SignalScan.agent_job_id == job.id)
    scan = (await db.execute(scan_stmt)).scalar_one_or_none()
    if scan is None:
        scan = SignalScan(
            entity_id=entity.id,
            agent_job_id=job.id,
            scan_depth=scan_depth,
            trigger=trigger,
        )
        db.add(scan)
    else:
        await db.execute(delete(SignalResult).where(SignalResult.scan_id == scan.id))
    scan.status = "running"
    scan.started_at = utc_now()
    await db.flush()

    signals_stmt = select(Signal).where(Signal.is_active.is_(True))
    if scan_depth != "full":
        signals_stmt = signals_stmt.where(Signal.scan_tier == 1)
    signals = list(
        (await db.execute(signals_stmt.order_by(Signal.number))).scalars().all()
    )
    if not signals:
        raise RuntimeError("Signal library is empty — run seed_signals first")

    context = await _company_context(db, entity)
    batch_size = max(settings.signal_scan_batch_size, 5)
    batches = [signals[i : i + batch_size] for i in range(0, len(signals), batch_size)]

    results_by_number: dict[int, dict] = {}
    failed_batches = 0
    for index, batch in enumerate(batches):
        signal_block = "\n".join(_signal_line(s) for s in batch)
        user_prompt = (
            f"{context}\n\n"
            f"Evaluate these {len(batch)} signals (batch {index + 1}/{len(batches)}):\n"
            f"{signal_block}"
        )
        try:
            payload_json = await run_ops_json_prompt(
                agent="signal-scan",
                system_prompt=SCAN_SYSTEM_PROMPT,
                user_prompt=user_prompt,
                timeout_seconds=240,
                caller=f"signal_scan:{entity.display_name}:batch{index + 1}",
            )
            results_by_number.update(_parse_batch_results(payload_json))
        except Exception:
            failed_batches += 1
            logger.exception(
                "signal_scan_batch_failed",
                entity_id=entity.id,
                batch=index + 1,
                batches=len(batches),
            )

    if failed_batches == len(batches):
        scan.status = "failed"
        scan.error = "all scan batches failed"
        await db.flush()
        raise RuntimeError("Signal scan failed: no batch returned results")

    scoring = compute_scan_scoring(signals, results_by_number)

    for item in scoring["per_signal"]:
        db.add(
            SignalResult(
                scan_id=scan.id,
                signal_id=item["signal"].id,
                result=item["result"],
                evidence_url=item["evidence_url"],
                note=item["note"],
                points_earned=item["points_earned"],
            )
        )

    top_confirmed = [
        item["signal"].name
        for item in scoring["per_signal"]
        if item["result"] == "confirmed" and item["signal"].strength == "high"
    ][:6]
    rationale_parts = [
        f"{entity.display_name} scored {scoring['points_earned']}/{scoring['points_possible']} "
        f"({round(scoring['score_pct'] * 100)}%, {scoring['band']}) on a {scan_depth} scan "
        f"of {len(signals)} signals."
    ]
    if top_confirmed:
        rationale_parts.append("Strongest confirmed: " + "; ".join(top_confirmed) + ".")
    if scoring["veto_flags"]:
        rationale_parts.append(
            "Review flags: " + "; ".join(f["name"] for f in scoring["veto_flags"]) + "."
        )
    if failed_batches:
        rationale_parts.append(f"{failed_batches} batch(es) failed and were marked unknown.")

    scan.status = "completed"
    scan.completed_at = utc_now()
    scan.points_earned = scoring["points_earned"]
    scan.points_possible = scoring["points_possible"]
    scan.score_pct = scoring["score_pct"]
    scan.band = scoring["band"]
    scan.veto_flags = scoring["veto_flags"]
    scan.category_scores = scoring["category_scores"]
    scan.signals_confirmed = scoring["counts"]["confirmed"]
    scan.signals_absent = scoring["counts"]["absent"]
    scan.signals_unknown = scoring["counts"]["unknown"]
    scan.rationale = " ".join(rationale_parts)

    # The scan score becomes the company's watchlist score
    target_stmt = select(WatchTarget).where(
        WatchTarget.entity_id == entity.id, WatchTarget.target_type == "company"
    )
    target = (await db.execute(target_stmt)).scalar_one_or_none()
    if target is None:
        target = WatchTarget(entity_id=entity.id, target_type="company")
        db.add(target)
    target.score = scoring["score_pct"]
    target.status = "active" if scoring["band"] in ("strong", "moderate") else "watch"

    metadata = dict(entity.metadata_ or {})
    metadata["latest_signal_scan"] = {
        "scan_id": scan.id,
        "score_pct": scoring["score_pct"],
        "band": scoring["band"],
        "veto_count": len(scoring["veto_flags"]),
        "completed_at": scan.completed_at.isoformat(),
    }
    entity.metadata_ = metadata

    await enqueue_event(
        db,
        event_type="watchlist_update_ready",
        payload={"entity_id": entity.id, "entity_type": "company"},
        dedup_key=f"watchlist_update_ready:scan:{scan.id}",
        entity_id=entity.id,
    )

    await db.flush()
    logger.info(
        "signal_scan_completed",
        entity_id=entity.id,
        entity=entity.display_name,
        scan_id=scan.id,
        score_pct=scoring["score_pct"],
        band=scoring["band"],
        vetoes=len(scoring["veto_flags"]),
        llm_calls=len(batches) - failed_batches,
    )
    return {
        "entity_id": entity.id,
        "scan_id": scan.id,
        "score_pct": scoring["score_pct"],
        "band": scoring["band"],
    }


# ---------------------------------------------------------------------------
# Enqueue helpers (cooldown + daily cap = cost control)
# ---------------------------------------------------------------------------


async def enqueue_signal_scan(
    db: AsyncSession,
    *,
    entity_id: int,
    scan_depth: str = "standard",
    trigger: str = "manual",
    force: bool = False,
) -> AgentJob | None:
    """Enqueue a signal scan unless one ran recently or the daily cap is hit."""
    if not force:
        cooldown_cutoff = utc_now() - timedelta(days=settings.signal_scan_cooldown_days)
        recent_stmt = select(SignalScan.id).where(
            SignalScan.entity_id == entity_id,
            SignalScan.status == "completed",
            SignalScan.created_at >= cooldown_cutoff,
        )
        if (await db.execute(recent_stmt.limit(1))).scalar_one_or_none() is not None:
            logger.info("signal_scan_skipped_cooldown", entity_id=entity_id)
            return None

    if trigger == "auto":
        day_start = utc_now().replace(hour=0, minute=0, second=0, microsecond=0)
        count_stmt = select(func.count(AgentJob.id)).where(
            AgentJob.job_type == "signal_scan",
            AgentJob.created_at >= day_start,
        )
        today_count = (await db.execute(count_stmt)).scalar_one()
        if today_count >= settings.signal_scan_auto_daily_limit:
            logger.info("signal_scan_skipped_daily_cap", entity_id=entity_id)
            return None

    month_bucket = utc_now().strftime("%Y%m")
    external_ref = f"signal_scan:{entity_id}:{month_bucket}"
    if force:
        external_ref = f"signal_scan:{entity_id}:{utc_now().isoformat()}"

    return await enqueue_agent_job(
        db,
        job_type="signal_scan",
        payload={"entity_id": entity_id, "scan_depth": scan_depth, "trigger": trigger},
        external_ref=external_ref,
        entity_id=entity_id,
        priority=45,
    )
