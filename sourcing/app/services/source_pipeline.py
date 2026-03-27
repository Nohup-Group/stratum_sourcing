"""Source onboarding, cadence, and self-growth helpers."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import Entity, EntityScore, Source
from app.services.job_queue import enqueue_agent_job
from app.services.ops_client import run_ops_json_prompt

CADENCE_DELTA = {
    "hourly": timedelta(hours=1),
    "every_6_hours": timedelta(hours=6),
    "daily": timedelta(days=1),
    "weekly": timedelta(days=7),
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def infer_fetch_strategy(url: str | None, category: str) -> str:
    normalized = (url or "").lower()
    if normalized.endswith(".xml") or "rss" in normalized or "feed" in normalized:
        return "rss"
    if category in {"person", "company"}:
        return "browser"
    return "web_scrape"


def infer_cadence_bucket(category: str, url: str | None = None) -> str:
    if category in {"newsletter", "regulator"}:
        return "hourly" if infer_fetch_strategy(url, category) == "rss" else "every_6_hours"
    if category in {"person", "association", "company"}:
        return "daily"
    if category in {"conference", "university", "vc"}:
        return "weekly" if category in {"conference", "university"} else "daily"
    return "daily"


def compute_next_ingest_at(source: Source, *, from_time: datetime | None = None) -> datetime:
    baseline = from_time or utc_now()
    delta = CADENCE_DELTA.get(source.cadence_bucket or "daily", timedelta(days=1))
    return baseline + delta


def _domain_hint(url: str | None) -> str:
    if not url:
        return ""
    try:
        return urlparse(url).netloc.lower()
    except ValueError:
        return ""


async def classify_source(source: Source) -> dict:
    system_prompt = """You classify sourcing inputs for an autonomous venture sourcing system.
Return JSON only with keys:
- category
- fetch_strategy
- cadence_bucket
- activate
- rationale
Allowed category values: company, person, association, newsletter, university, conference, vc, regulator.
Allowed fetch_strategy values: rss, web_scrape, browser.
Allowed cadence_bucket values: hourly, every_6_hours, daily, weekly."""
    user_prompt = f"""Source name: {source.name}
Current category: {source.category}
Primary URL: {source.url or ""}
Description: {source.description or ""}
Notes: {source.notes or ""}
Domain hint: {_domain_hint(source.url)}

Prefer conservative classifications. Use browser for person or company pages that likely need rendering.
Use hourly or every_6_hours for frequently updated feeds and regulators, daily for people and companies, weekly for slower institutional pages."""
    try:
        return await run_ops_json_prompt(
            agent="source-onboarder",
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            timeout_seconds=90,
            caller=f"source_onboarder:source_{source.id}:{source.name}",
        )
    except Exception:
        return {
            "category": source.category,
            "fetch_strategy": source.fetch_strategy or infer_fetch_strategy(source.url, source.category),
            "cadence_bucket": infer_cadence_bucket(source.category, source.url),
            "activate": True,
            "rationale": "Heuristic source classification fallback",
        }


async def onboard_source(db: AsyncSession, source: Source) -> dict:
    classification = await classify_source(source)
    source.category = classification.get("category") or source.category
    source.fetch_strategy = classification.get("fetch_strategy") or infer_fetch_strategy(
        source.url, source.category
    )
    source.cadence_bucket = classification.get("cadence_bucket") or infer_cadence_bucket(
        source.category, source.url
    )
    source.is_active = bool(classification.get("activate", True))
    source.onboarding_status = "bootstrap_pending" if source.is_active else "paused"
    source.next_ingest_at = utc_now()
    rationale = classification.get("rationale", "")
    if rationale:
        existing = source.notes or ""
        source.notes = f"{existing}\n{rationale}".strip()
    await db.flush()
    return classification


async def maybe_create_source_from_entity(
    db: AsyncSession,
    *,
    entity: Entity,
    parent_source_id: int | None,
) -> Source | None:
    score_stmt = (
        select(EntityScore)
        .where(EntityScore.entity_id == entity.id)
        .order_by(EntityScore.last_scored_at.desc())
        .limit(1)
    )
    score = (await db.execute(score_stmt)).scalar_one_or_none()
    if score is None:
        return None

    threshold = (
        settings.watchlist_company_threshold
        if entity.entity_type == "company"
        else settings.watchlist_people_threshold
    )
    if score.score < max(threshold, 0.65):
        return None

    today = utc_now().date()
    daily_count = (
        await db.execute(
            select(func.count(Source.id)).where(
                Source.discovery_mode == "self-grown",
                func.date(Source.created_at) == today,
            )
        )
    ).scalar_one()
    if daily_count >= settings.auto_growth_daily_limit:
        return None

    if parent_source_id:
        per_parent_count = (
            await db.execute(
                select(func.count(Source.id)).where(
                    Source.discovery_mode == "self-grown",
                    Source.parent_source_id == parent_source_id,
                    func.date(Source.created_at) == today,
                )
            )
        ).scalar_one()
        if per_parent_count >= settings.auto_growth_per_parent_limit:
            return None

    metadata = entity.metadata_ or {}
    candidate_urls = list(dict.fromkeys(metadata.get("candidate_source_urls") or []))
    if entity.canonical_url and entity.canonical_url not in candidate_urls:
        candidate_urls.insert(0, entity.canonical_url)
    candidate_url = next((url for url in candidate_urls if url), None)
    if not candidate_url:
        return None

    existing_stmt = select(Source).where(
        or_(
            Source.url == candidate_url,
            (
                (Source.name == entity.display_name)
                & (Source.category == entity.entity_type)
            ),
        )
    )
    existing = (await db.execute(existing_stmt)).scalar_one_or_none()
    if existing is not None:
        return existing

    new_source = Source(
        name=entity.display_name,
        category=entity.entity_type,
        fetch_strategy=infer_fetch_strategy(candidate_url, entity.entity_type),
        url=candidate_url,
        secondary_urls=candidate_urls[1:],
        description=entity.description,
        notes=score.rationale,
        verticals=entity.thesis_tags or [],
        is_active=False,
        discovery_mode="self-grown",
        parent_source_id=parent_source_id,
        cadence_bucket=infer_cadence_bucket(entity.entity_type, candidate_url),
        onboarding_status="queued",
        auto_growth_state="candidate",
    )
    db.add(new_source)
    await db.flush()
    await enqueue_agent_job(
        db,
        job_type="source_onboarder",
        payload={"source_id": new_source.id, "trigger": "self-grown"},
        external_ref=f"source:{new_source.id}:onboard",
        source_id=new_source.id,
        entity_id=entity.id,
        priority=10,
    )
    return new_source
