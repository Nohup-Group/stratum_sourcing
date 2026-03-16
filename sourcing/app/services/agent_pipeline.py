"""Background agent workflows for extraction, research, scoring, and self-growth."""

from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Any

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings
from app.database import async_session_factory
from app.models import (
    AgentJob,
    Entity,
    EntityMention,
    EntityResearchSnapshot,
    EntityScore,
    Evidence,
    Finding,
    Source,
    WatchTarget,
)
from app.pipeline.scorer import EARLY_STAGE_KEYWORDS, EUROPE_KEYWORDS, SOURCE_AUTHORITY, VERTICAL_KEYWORDS
from app.services.job_queue import (
    claim_pending_jobs,
    dispatch_outbox_events,
    enqueue_event,
    mark_job_failed,
)
from app.services.ops_client import run_ops_json_prompt
from app.services.source_pipeline import maybe_create_source_from_entity, onboard_source

logger = structlog.get_logger()

PERSON_ROLE_HINTS = [
    "founder",
    "co-founder",
    "ceo",
    "cto",
    "chief",
    "partner",
    "principal",
    "head of",
    "director",
]
COMPANY_SUFFIXES = [
    "labs",
    "capital",
    "ventures",
    "bank",
    "finance",
    "systems",
    "network",
    "protocol",
    "payments",
    "technologies",
]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def normalize_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def _keyword_score(text: str, keywords: list[str], max_hits: int = 3) -> float:
    hits = sum(1 for keyword in keywords if keyword.lower() in text)
    return clamp(hits / max_hits)


def _recency_score(timestamp: datetime | None) -> float:
    if timestamp is None:
        return 0.4
    days_old = max((utc_now() - timestamp.astimezone(timezone.utc)).days, 0)
    if days_old <= 1:
        return 1.0
    if days_old <= 7:
        return 0.8
    if days_old <= 30:
        return 0.5
    return 0.2


def _auto_thesis_tags(text: str) -> list[str]:
    tagged = []
    lowered = text.lower()
    for vertical, keywords in VERTICAL_KEYWORDS.items():
        if any(keyword.lower() in lowered for keyword in keywords):
            tagged.append(vertical)
    return tagged


def _guess_entity_type(name: str) -> str:
    lowered = name.lower()
    if any(suffix in lowered for suffix in COMPANY_SUFFIXES):
        return "company"
    tokens = [token for token in name.split() if token]
    if len(tokens) == 2 and all(token[:1].isupper() for token in tokens):
        return "person"
    return "company"


def _candidate_urls_from_context(entity_name: str, urls: list[str]) -> list[str]:
    tokens = [token for token in normalize_name(entity_name).split() if len(token) >= 4]
    matches = []
    for url in urls:
        lowered = url.lower()
        if any(token in lowered for token in tokens):
            matches.append(url)
    return list(dict.fromkeys(matches))


def _heuristic_extract_entities(finding: Finding, source: Source | None) -> list[dict]:
    metadata = finding.metadata_ or {}
    extracted = []
    raw_entities = metadata.get("entities") or []
    for item in raw_entities:
        name = str(item).strip()
        if not name:
            continue
        extracted.append(
            {
                "name": name,
                "entity_type": _guess_entity_type(name),
                "role_hint": None,
                "confidence": 0.55,
            }
        )

    if extracted:
        return extracted

    title_matches = re.findall(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b", finding.title)
    for match in title_matches[:5]:
        if normalize_name(match) == normalize_name(source.name if source else ""):
            continue
        extracted.append(
            {
                "name": match,
                "entity_type": _guess_entity_type(match),
                "role_hint": None,
                "confidence": 0.35,
            }
        )
    return extracted


async def _extract_entities_with_agent(finding: Finding, source: Source | None) -> list[dict]:
    evidence_lines = [
        f"- {ev.url}: {ev.excerpt[:300]}"
        for ev in finding.evidence_items
    ]
    system_prompt = """You extract companies and people from venture sourcing evidence.
Return JSON only with:
{"entities":[{"name":"","entity_type":"company|person","role_hint":"","confidence":0.0,"canonical_url":"","candidate_source_urls":[],"thesis_tags":[]}]}
Only include real companies or people relevant to the finding. Use company for startups, funds, institutions, and protocols. Use person for founders, executives, investors, or operators."""
    user_prompt = f"""Finding title: {finding.title}
Finding summary: {finding.summary}
Finding category: {finding.category or ""}
Source name: {source.name if source else ""}
Source category: {source.category if source else ""}
Source URL: {source.url if source else ""}
Evidence:
{chr(10).join(evidence_lines) if evidence_lines else "- None"}

Return at most 8 entities. Include candidate_source_urls when the evidence already exposes a directly followable URL."""
    response = await run_ops_json_prompt(
        agent="entity-extractor",
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        timeout_seconds=90,
    )
    return list(response.get("entities") or [])


async def _get_or_create_entity(
    db: AsyncSession,
    *,
    entity_type: str,
    name: str,
    canonical_url: str | None,
    description: str | None,
    thesis_tags: list[str],
) -> Entity:
    normalized = normalize_name(name)
    stmt = select(Entity).where(
        Entity.entity_type == entity_type,
        Entity.normalized_name == normalized,
    )
    entity = (await db.execute(stmt)).scalar_one_or_none()
    if entity is None:
        entity = Entity(
            entity_type=entity_type,
            display_name=name,
            normalized_name=normalized,
            canonical_url=canonical_url,
            description=description,
            thesis_tags=thesis_tags,
        )
        db.add(entity)
        await db.flush()
        return entity

    entity.display_name = name
    if canonical_url and not entity.canonical_url:
        entity.canonical_url = canonical_url
    if description and not entity.description:
        entity.description = description
    merged_tags = sorted(set(entity.thesis_tags or []).union(thesis_tags))
    entity.thesis_tags = merged_tags
    entity.last_seen_at = utc_now()
    await db.flush()
    return entity


async def _entity_context(
    db: AsyncSession,
    entity_id: int,
) -> tuple[Entity, list[EntityMention]]:
    stmt = (
        select(Entity)
        .options(
            selectinload(Entity.mentions)
            .selectinload(EntityMention.finding)
            .selectinload(Finding.source),
            selectinload(Entity.mentions).selectinload(EntityMention.evidence),
            selectinload(Entity.scores),
            selectinload(Entity.research_snapshots),
        )
        .where(Entity.id == entity_id)
    )
    entity = (await db.execute(stmt)).scalar_one()
    mentions = list(entity.mentions)
    return entity, mentions


async def process_entity_extractor_job(db: AsyncSession, job: AgentJob) -> dict:
    payload = job.payload or {}
    finding_ids = list(payload.get("finding_ids") or [])
    source_id = payload.get("source_id")
    source = await db.get(Source, source_id) if source_id else None
    findings_stmt = (
        select(Finding)
        .options(selectinload(Finding.evidence_items))
        .where(Finding.id.in_(finding_ids))
        .order_by(Finding.id.asc())
    )
    findings = list((await db.execute(findings_stmt)).scalars().all())

    created_mentions = 0
    created_entities = 0
    for finding in findings:
        try:
            raw_entities = await _extract_entities_with_agent(finding, source)
        except Exception:
            raw_entities = _heuristic_extract_entities(finding, source)

        evidence_urls = [ev.url for ev in finding.evidence_items]
        for raw in raw_entities:
            name = str(raw.get("name") or "").strip()
            if not name:
                continue
            entity_type = raw.get("entity_type") or _guess_entity_type(name)
            thesis_tags = list(
                dict.fromkeys(
                    (raw.get("thesis_tags") or [])
                    + _auto_thesis_tags(f"{finding.title} {finding.summary}")
                )
            )
            entity = await _get_or_create_entity(
                db,
                entity_type=entity_type,
                name=name,
                canonical_url=raw.get("canonical_url") or None,
                description=finding.summary[:500],
                thesis_tags=thesis_tags,
            )
            if entity.finding_count == 0:
                created_entities += 1

            metadata = dict(entity.metadata_ or {})
            candidate_urls = _candidate_urls_from_context(
                name,
                (raw.get("candidate_source_urls") or []) + evidence_urls,
            )
            if candidate_urls:
                metadata["candidate_source_urls"] = list(
                    dict.fromkeys((metadata.get("candidate_source_urls") or []) + candidate_urls)
                )
            if raw.get("role_hint"):
                metadata["last_role_hint"] = raw.get("role_hint")
            entity.metadata_ = metadata

            existing_mention_stmt = select(EntityMention).where(
                EntityMention.entity_id == entity.id,
                EntityMention.finding_id == finding.id,
                EntityMention.mention_text == name,
            )
            existing_mention = (await db.execute(existing_mention_stmt)).scalar_one_or_none()
            if existing_mention is None:
                mention = EntityMention(
                    entity_id=entity.id,
                    finding_id=finding.id,
                    source_id=finding.source_id,
                    mention_text=name,
                    role_hint=raw.get("role_hint") or None,
                    confidence=float(raw.get("confidence") or 0.4),
                    context_excerpt=finding.summary[:500],
                )
                db.add(mention)
                created_mentions += 1

            entity.finding_count += 1
            entity.source_count = int(
                (
                    await db.execute(
                        select(func.count(func.distinct(Finding.source_id)))
                        .select_from(EntityMention)
                        .join(Finding, EntityMention.finding_id == Finding.id, isouter=True)
                        .where(EntityMention.entity_id == entity.id)
                    )
                ).scalar_one()
                or 0
            )
            entity.last_seen_at = utc_now()

            await enqueue_event(
                db,
                event_type="entity_candidate",
                payload={
                    "entity_id": entity.id,
                    "entity_type": entity.entity_type,
                    "source_id": finding.source_id,
                    "finding_id": finding.id,
                },
                dedup_key=f"entity_candidate:{finding.id}:{entity.id}",
                source_id=finding.source_id,
                entity_id=entity.id,
            )

    await db.flush()
    return {
        "findings_processed": len(findings),
        "created_mentions": created_mentions,
        "created_entities": created_entities,
    }


def _default_research_profile(entity: Entity, mentions: list[EntityMention]) -> dict:
    findings = [mention.finding for mention in mentions if mention.finding]
    texts = " ".join(
        f"{finding.title} {finding.summary}" for finding in findings if finding is not None
    )
    candidate_urls = list(dict.fromkeys((entity.metadata_ or {}).get("candidate_source_urls") or []))
    return {
        "summary": (entity.description or texts[:500] or entity.display_name)[:1000],
        "thesis_tags": sorted(set(entity.thesis_tags or _auto_thesis_tags(texts))),
        "canonical_url": entity.canonical_url or (candidate_urls[0] if candidate_urls else ""),
        "candidate_source_urls": candidate_urls,
        "linked_companies": [],
        "sourceable": bool(candidate_urls),
        "evidence_urls": candidate_urls,
        "rationale": "Heuristic research synthesis",
    }


async def _research_with_agent(entity: Entity, mentions: list[EntityMention]) -> dict:
    evidence_urls = []
    context_lines = []
    for mention in mentions[:20]:
        finding = mention.finding
        source = finding.source if finding else None
        if mention.evidence and mention.evidence.url:
            evidence_urls.append(mention.evidence.url)
        if finding:
            context_lines.append(
                f"- [{source.name if source else 'unknown source'}] {finding.title}: {finding.summary}"
            )

    system_prompt = """You build compact venture sourcing profiles for companies and people.
Return JSON only with keys:
- summary
- thesis_tags
- canonical_url
- candidate_source_urls
- linked_companies
- sourceable
- rationale
Be conservative. Only emit URLs that appear directly in the supplied context or are obvious canonical URLs from the evidence."""
    user_prompt = f"""Entity name: {entity.display_name}
Entity type: {entity.entity_type}
Known canonical URL: {entity.canonical_url or ""}
Known thesis tags: {", ".join(entity.thesis_tags or [])}
Context:
{chr(10).join(context_lines) if context_lines else "- No context"}

Evidence URLs:
{chr(10).join(f"- {url}" for url in evidence_urls) if evidence_urls else "- None"}"""
    return await run_ops_json_prompt(
        agent="company-researcher" if entity.entity_type == "company" else "people-researcher",
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        timeout_seconds=120,
    )


async def process_research_job(db: AsyncSession, job: AgentJob) -> dict:
    entity_id = int((job.payload or {}).get("entity_id") or job.entity_id)
    entity, mentions = await _entity_context(db, entity_id)
    try:
        profile = await _research_with_agent(entity, mentions)
    except Exception:
        profile = _default_research_profile(entity, mentions)

    summary = str(profile.get("summary") or entity.description or entity.display_name)
    candidate_urls = list(dict.fromkeys(profile.get("candidate_source_urls") or []))
    if profile.get("canonical_url") and profile["canonical_url"] not in candidate_urls:
        candidate_urls.insert(0, profile["canonical_url"])

    entity.description = summary[:2000]
    entity.canonical_url = profile.get("canonical_url") or entity.canonical_url
    entity.thesis_tags = sorted(
        set(entity.thesis_tags or []).union(profile.get("thesis_tags") or [])
    )
    metadata = dict(entity.metadata_ or {})
    metadata["candidate_source_urls"] = list(
        dict.fromkeys((metadata.get("candidate_source_urls") or []) + candidate_urls)
    )
    metadata["linked_companies"] = profile.get("linked_companies") or metadata.get("linked_companies") or []
    metadata["sourceable"] = bool(profile.get("sourceable") or metadata.get("candidate_source_urls"))
    entity.metadata_ = metadata

    snapshot = EntityResearchSnapshot(
        entity_id=entity.id,
        agent_job_id=job.id,
        summary=summary[:4000],
        profile=profile,
        evidence_urls=candidate_urls,
    )
    db.add(snapshot)
    event_timestamp = utc_now().isoformat()

    await enqueue_event(
        db,
        event_type="entity_profile_ready",
        payload={"entity_id": entity.id, "entity_type": entity.entity_type},
        dedup_key=f"entity_profile_ready:{entity.id}:{event_timestamp}",
        entity_id=entity.id,
    )
    if metadata.get("sourceable"):
        await enqueue_event(
            db,
            event_type="source_expansion_candidate",
            payload={"entity_id": entity.id, "entity_type": entity.entity_type, "source_id": job.source_id},
            dedup_key=f"source_expansion_candidate:{entity.id}:{job.source_id or 0}",
            entity_id=entity.id,
            source_id=job.source_id,
        )

    await db.flush()
    return {"entity_id": entity.id, "summary": summary[:200]}


async def _linked_company_score(db: AsyncSession, entity: Entity) -> float:
    linked_companies = (entity.metadata_ or {}).get("linked_companies") or []
    if not linked_companies:
        return 0.0

    normalized = [normalize_name(name) for name in linked_companies]
    stmt = (
        select(EntityScore.score)
        .join(Entity, Entity.id == EntityScore.entity_id)
        .where(
            Entity.entity_type == "company",
            Entity.normalized_name.in_(normalized),
        )
    )
    scores = [row[0] for row in (await db.execute(stmt)).all()]
    if not scores:
        return 0.0
    return sum(scores) / len(scores)


async def process_entity_scorer_job(db: AsyncSession, job: AgentJob) -> dict:
    entity_id = int((job.payload or {}).get("entity_id") or job.entity_id)
    entity, mentions = await _entity_context(db, entity_id)
    mention_findings = [mention.finding for mention in mentions if mention.finding]
    texts = " ".join(
        f"{finding.title} {finding.summary}" for finding in mention_findings if finding is not None
    ).lower()
    authority_values = [
        SOURCE_AUTHORITY.get(finding.source.category, 0.5)
        for finding in mention_findings
        if finding and finding.source
    ]
    authority = sum(authority_values) / len(authority_values) if authority_values else 0.4
    thesis_fit = clamp(len(entity.thesis_tags or _auto_thesis_tags(texts)) / 3)
    europe_relevance = _keyword_score(texts, EUROPE_KEYWORDS, max_hits=4)
    recency_momentum = _recency_score(entity.last_seen_at)
    evidence_depth = clamp(math.log1p(max(entity.finding_count, 0)) / math.log(6))
    sourceable = 1.0 if (entity.metadata_ or {}).get("sourceable") else 0.0
    stage_fit = _keyword_score(texts, EARLY_STAGE_KEYWORDS, max_hits=3)
    linked_company_strength = await _linked_company_score(db, entity)

    if entity.entity_type == "company":
        components = {
            "thesis_fit": thesis_fit,
            "stage_fit": stage_fit,
            "europe_relevance": europe_relevance,
            "recency_momentum": recency_momentum,
            "source_authority": authority,
            "evidence_depth": evidence_depth,
        }
        score_value = (
            0.28 * thesis_fit
            + 0.15 * stage_fit
            + 0.15 * europe_relevance
            + 0.14 * recency_momentum
            + 0.14 * authority
            + 0.14 * evidence_depth
        )
    else:
        seniority = _keyword_score(texts, PERSON_ROLE_HINTS, max_hits=2)
        components = {
            "thesis_fit": thesis_fit,
            "linked_company_strength": linked_company_strength,
            "role_seniority": seniority,
            "recency_momentum": recency_momentum,
            "source_authority": authority,
            "sourceability": sourceable,
        }
        score_value = (
            0.22 * thesis_fit
            + 0.22 * linked_company_strength
            + 0.18 * seniority
            + 0.14 * recency_momentum
            + 0.12 * authority
            + 0.12 * sourceable
        )

    rationale = (
        f"{entity.display_name} scored {round(score_value, 3)} based on "
        f"{', '.join(f'{key}={round(value, 2)}' for key, value in components.items())}."
    )

    stmt = select(EntityScore).where(EntityScore.entity_id == entity.id)
    score = (await db.execute(stmt)).scalar_one_or_none()
    if score is None:
        score = EntityScore(
            entity_id=entity.id,
            first_scored_at=utc_now(),
        )
        db.add(score)

    score.score = round(clamp(score_value), 4)
    score.components = components
    score.rationale = rationale
    score.evidence_count = entity.finding_count
    score.source_count = entity.source_count
    score.last_scored_at = utc_now()

    threshold = (
        settings.watchlist_company_threshold
        if entity.entity_type == "company"
        else settings.watchlist_people_threshold
    )
    target_stmt = select(WatchTarget).where(
        WatchTarget.entity_id == entity.id,
        WatchTarget.target_type == entity.entity_type,
    )
    target = (await db.execute(target_stmt)).scalar_one_or_none()
    if target is None:
        target = WatchTarget(entity_id=entity.id, target_type=entity.entity_type)
        db.add(target)
    target.status = "active" if score.score >= threshold else "watch"
    target.score = score.score

    await enqueue_event(
        db,
        event_type="watchlist_update_ready",
        payload={"entity_id": entity.id, "entity_type": entity.entity_type},
        dedup_key=f"watchlist_update_ready:{entity.id}:{score.last_scored_at.isoformat()}",
        entity_id=entity.id,
    )

    await db.flush()
    return {"entity_id": entity.id, "score": score.score}


async def process_source_expander_job(db: AsyncSession, job: AgentJob) -> dict:
    entity_id = int((job.payload or {}).get("entity_id") or job.entity_id)
    entity = await db.get(Entity, entity_id)
    if entity is None:
        return {"created": False}
    source = await maybe_create_source_from_entity(
        db,
        entity=entity,
        parent_source_id=job.source_id,
    )
    return {"created": bool(source), "source_id": source.id if source else None}


async def process_source_onboarder_job(db: AsyncSession, job: AgentJob) -> dict:
    source_id = int((job.payload or {}).get("source_id") or job.source_id)
    source = await db.get(Source, source_id)
    if source is None:
        return {"updated": False}
    classification = await onboard_source(db, source)
    return {"updated": True, "source_id": source.id, "classification": classification}


async def process_agent_job(db: AsyncSession, job: AgentJob) -> dict:
    if job.job_type == "entity_extractor":
        return await process_entity_extractor_job(db, job)
    if job.job_type in {"company_researcher", "people_researcher"}:
        return await process_research_job(db, job)
    if job.job_type == "entity_scorer":
        return await process_entity_scorer_job(db, job)
    if job.job_type == "source_expander":
        return await process_source_expander_job(db, job)
    if job.job_type == "source_onboarder":
        return await process_source_onboarder_job(db, job)
    raise ValueError(f"Unsupported job_type={job.job_type}")


async def run_agent_job_cycle(limit: int = 25, lease_owner: str = "agent-worker") -> dict:
    async with async_session_factory() as db:
        dispatched = await dispatch_outbox_events(db, limit=limit)
        jobs = await claim_pending_jobs(db, limit=limit, lease_owner=lease_owner)
        processed = 0
        failed = 0

        for job in jobs:
            try:
                result = await process_agent_job(db, job)
                job.result = result
                job.status = "completed"
                job.leased_at = None
                job.lease_owner = None
                processed += 1
            except Exception as error:
                logger.exception("agent_job_failed", job_id=job.id, job_type=job.job_type)
                await mark_job_failed(db, job, error=str(error), retry=job.attempts < 4)
                failed += 1

        await db.commit()
        return {
            "dispatched_events": dispatched,
            "processed_jobs": processed,
            "failed_jobs": failed,
        }
