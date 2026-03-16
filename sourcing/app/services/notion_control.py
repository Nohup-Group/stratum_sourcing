"""Notion control-plane management and sync helpers."""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime, timezone
from typing import Any

import httpx
import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings
from app.database import async_session_factory
from app.models import Entity, Finding, Notification, Source, WatchTarget
from app.services.job_queue import get_integration_state, upsert_integration_state

logger = structlog.get_logger()

NOTION_CONTROL_STATE = "notion_control_plane"
NOTION_WEBHOOK_STATE = "notion_webhook"

SOURCE_REGISTRY_TITLE = "Source Registry"
COMPANY_WATCHLIST_TITLE = "Company Watchlist"
PEOPLE_WATCHLIST_TITLE = "People Watchlist"


def _plain_text(chunks: list[dict] | None) -> str:
    if not chunks:
        return ""
    return "".join(chunk.get("plain_text", "") for chunk in chunks).strip()


def _title_property(value: str) -> dict:
    return {"title": [{"text": {"content": value[:2000]}}]}


def _rich_text_property(value: str) -> dict:
    if not value:
        return {"rich_text": []}
    return {"rich_text": [{"text": {"content": value[:2000]}}]}


def _date_property(value: datetime | None) -> dict:
    if value is None:
        return {"date": None}
    return {"date": {"start": value.astimezone(timezone.utc).isoformat()}}


def _multi_select_property(values: list[str]) -> dict:
    return {"multi_select": [{"name": item[:100]} for item in values if item]}


def _get_page_title(page: dict) -> str:
    properties = page.get("properties", {})
    for prop in properties.values():
        if prop.get("type") == "title":
            return _plain_text(prop.get("title"))
    return ""


def _extract_prop_text(page: dict, name: str) -> str:
    prop = page.get("properties", {}).get(name, {})
    prop_type = prop.get("type")
    if prop_type == "title":
        return _plain_text(prop.get("title"))
    if prop_type == "rich_text":
        return _plain_text(prop.get("rich_text"))
    if prop_type == "url":
        return prop.get("url") or ""
    if prop_type == "select":
        return (prop.get("select") or {}).get("name", "")
    if prop_type == "number":
        number = prop.get("number")
        return "" if number is None else str(number)
    return ""


def _extract_prop_date(page: dict, name: str) -> datetime | None:
    prop = page.get("properties", {}).get(name, {})
    value = prop.get("date")
    if not value or not value.get("start"):
        return None
    try:
        return datetime.fromisoformat(value["start"].replace("Z", "+00:00"))
    except ValueError:
        return None


def _source_registry_schema() -> dict[str, dict]:
    return {
        "Name": {"title": {}},
        "Source Type": {
            "select": {
                "options": [{"name": name} for name in [
                    "company",
                    "person",
                    "association",
                    "newsletter",
                    "university",
                    "conference",
                    "vc",
                    "regulator",
                ]]
            }
        },
        "Primary URL": {"url": {}},
        "Secondary URLs": {"rich_text": {}},
        "Status": {
            "select": {
                "options": [{"name": name} for name in [
                    "candidate",
                    "active",
                    "paused",
                    "cooldown",
                    "error",
                ]]
            }
        },
        "Discovery Mode": {
            "select": {"options": [{"name": name} for name in ["manual", "self-grown"]]}
        },
        "Parent Source": {"rich_text": {}},
        "Cadence Bucket": {
            "select": {
                "options": [{"name": name} for name in ["hourly", "every_6_hours", "daily", "weekly"]]
            }
        },
        "Fetch Strategy": {
            "select": {"options": [{"name": name} for name in ["rss", "web_scrape", "browser"]]}
        },
        "Initial Backfill Status": {
            "select": {
                "options": [{"name": name} for name in [
                    "new",
                    "queued",
                    "bootstrap_pending",
                    "active",
                    "error",
                ]]
            }
        },
        "Last Ingested At": {"date": {}},
        "Next Ingest At": {"date": {}},
        "Notes / Rationale": {"rich_text": {}},
    }


def _watchlist_schema() -> dict[str, dict]:
    return {
        "Name": {"title": {}},
        "Status": {
            "select": {"options": [{"name": name} for name in ["active", "watch", "archive"]]}
        },
        "Score": {"number": {"format": "number_with_commas"}},
        "Rank": {"number": {"format": "number"}},
        "Summary": {"rich_text": {}},
        "Thesis Tags": {"multi_select": {}},
        "Source Count": {"number": {"format": "number"}},
        "Evidence Count": {"number": {"format": "number"}},
        "First Seen": {"date": {}},
        "Last Seen": {"date": {}},
        "Canonical URL": {"url": {}},
        "Rationale": {"rich_text": {}},
    }


class NotionAPI:
    def __init__(self) -> None:
        self._headers = {
            "authorization": f"Bearer {settings.notion_api_key}",
            "notion-version": settings.notion_api_version,
            "content-type": "application/json",
        }

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict | None = None,
        params: dict | None = None,
    ) -> dict:
        url = f"https://api.notion.com{path}"
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.request(
                method,
                url,
                headers=self._headers,
                json=json_body,
                params=params,
            )
            response.raise_for_status()
            return response.json()

    async def search_database(self, title: str) -> dict | None:
        body = {
            "query": title,
            "filter": {"property": "object", "value": "database"},
            "page_size": 20,
        }
        response = await self._request("POST", "/v1/search", json_body=body)
        for result in response.get("results", []):
            if _plain_text(result.get("title")) == title:
                return result
        return None

    async def retrieve_database(self, database_id: str) -> dict:
        return await self._request("GET", f"/v1/databases/{database_id}")

    async def retrieve_data_source(self, data_source_id: str) -> dict:
        return await self._request("GET", f"/v1/data_sources/{data_source_id}")

    async def retrieve_page(self, page_id: str) -> dict:
        return await self._request("GET", f"/v1/pages/{page_id}")

    async def create_database(
        self,
        *,
        parent_page_id: str,
        title: str,
        properties: dict,
    ) -> dict:
        body = {
            "parent": {"type": "page_id", "page_id": parent_page_id},
            "title": [{"type": "text", "text": {"content": title}}],
            "initial_data_source": {
                "title": [{"type": "text", "text": {"content": title}}],
                "properties": properties,
            },
        }
        return await self._request("POST", "/v1/databases", json_body=body)

    async def query_data_source(self, data_source_id: str, *, start_cursor: str | None = None) -> dict:
        body: dict[str, Any] = {"page_size": 100}
        if start_cursor:
            body["start_cursor"] = start_cursor
        return await self._request("POST", f"/v1/data_sources/{data_source_id}/query", json_body=body)

    async def query_all_pages(self, data_source_id: str) -> list[dict]:
        pages: list[dict] = []
        cursor: str | None = None
        while True:
            response = await self.query_data_source(data_source_id, start_cursor=cursor)
            pages.extend(item for item in response.get("results", []) if item.get("object") == "page")
            cursor = response.get("next_cursor")
            if not response.get("has_more"):
                break
        return pages

    async def create_page(self, *, data_source_id: str, properties: dict, children: list[dict] | None = None) -> dict:
        body = {
            "parent": {"type": "data_source_id", "data_source_id": data_source_id},
            "properties": properties,
        }
        if children:
            body["children"] = children
        return await self._request("POST", "/v1/pages", json_body=body)

    async def update_page(self, *, page_id: str, properties: dict) -> dict:
        return await self._request("PATCH", f"/v1/pages/{page_id}", json_body={"properties": properties})


def get_notion_api() -> NotionAPI | None:
    if not settings.notion_api_key:
        return None
    return NotionAPI()


async def _resolve_parent_page_id(api: NotionAPI, ocean_database_id: str | None) -> str | None:
    if settings.notion_parent_page_id:
        return settings.notion_parent_page_id
    if not ocean_database_id:
        return None
    database = await api.retrieve_database(ocean_database_id)
    parent = database.get("parent", {})
    if parent.get("type") == "page_id":
        return parent.get("page_id")
    return None


def _get_database_title(database: dict) -> str:
    return _plain_text(database.get("title"))


def _resolve_primary_data_source_id(database: dict) -> str | None:
    data_sources = database.get("data_sources") or []
    if not data_sources:
        initial_data_source = database.get("initial_data_source")
        if isinstance(initial_data_source, dict):
            return initial_data_source.get("id")
        return None
    return data_sources[0].get("id")


async def ensure_control_plane(db: AsyncSession) -> dict[str, dict]:
    api = get_notion_api()
    if api is None:
        return {}

    resources: dict[str, dict] = {}
    env_ids = {
        "ocean": settings.notion_ocean_database_id,
        "source_registry": settings.notion_source_registry_database_id,
        "company_watchlist": settings.notion_company_watchlist_database_id,
        "people_watchlist": settings.notion_people_watchlist_database_id,
    }
    state = await get_integration_state(db, NOTION_CONTROL_STATE)
    state_config = state.config if state else {}

    ocean_database_id = env_ids["ocean"] or state_config.get("ocean", {}).get("database_id")
    parent_page_id = await _resolve_parent_page_id(api, ocean_database_id)
    if not parent_page_id:
        logger.warning("notion_parent_page_missing")
        return state_config

    if ocean_database_id:
        ocean_db = await api.retrieve_database(ocean_database_id)
        resources["ocean"] = {
            "title": _get_database_title(ocean_db) or "Stratum Ocean",
            "database_id": ocean_db["id"],
            "data_source_id": _resolve_primary_data_source_id(ocean_db),
        }

    desired = {
        "source_registry": (SOURCE_REGISTRY_TITLE, _source_registry_schema()),
        "company_watchlist": (COMPANY_WATCHLIST_TITLE, _watchlist_schema()),
        "people_watchlist": (PEOPLE_WATCHLIST_TITLE, _watchlist_schema()),
    }

    for key, (title, properties) in desired.items():
        database = None
        database_id = env_ids.get(key) or state_config.get(key, {}).get("database_id")
        if database_id:
            database = await api.retrieve_database(database_id)
        else:
            database = await api.search_database(title)
            if database is None:
                database = await api.create_database(
                    parent_page_id=parent_page_id,
                    title=title,
                    properties=properties,
                )

        resources[key] = {
            "title": title,
            "database_id": database["id"],
            "data_source_id": _resolve_primary_data_source_id(database),
        }

    await upsert_integration_state(db, NOTION_CONTROL_STATE, resources)
    await db.flush()
    return resources


async def get_webhook_token(db: AsyncSession) -> str:
    if settings.notion_webhook_verification_token:
        return settings.notion_webhook_verification_token
    state = await get_integration_state(db, NOTION_WEBHOOK_STATE)
    if not state:
        return ""
    return str(state.config.get("verification_token") or "")


async def remember_webhook_token(db: AsyncSession, verification_token: str) -> None:
    await upsert_integration_state(
        db,
        NOTION_WEBHOOK_STATE,
        {"verification_token": verification_token},
    )
    await db.flush()


def verify_webhook_signature(body: bytes, signature: str, verification_token: str) -> bool:
    if not signature or not verification_token:
        return False
    computed = "sha256=" + hmac.new(
        verification_token.encode("utf-8"),
        body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(computed, signature)


def build_source_registry_properties(source: Source) -> dict:
    return {
        "Name": _title_property(source.name),
        "Source Type": {"select": {"name": source.category}},
        "Primary URL": {"url": source.url},
        "Secondary URLs": _rich_text_property("\n".join(source.secondary_urls or [])),
        "Status": {"select": {"name": "active" if source.is_active else "paused"}},
        "Discovery Mode": {"select": {"name": source.discovery_mode or "manual"}},
        "Parent Source": _rich_text_property(str(source.parent_source_id or "")),
        "Cadence Bucket": {"select": {"name": source.cadence_bucket or "daily"}},
        "Fetch Strategy": {"select": {"name": source.fetch_strategy}},
        "Initial Backfill Status": {"select": {"name": source.onboarding_status or "new"}},
        "Last Ingested At": _date_property(source.last_ingested_at),
        "Next Ingest At": _date_property(source.next_ingest_at),
        "Notes / Rationale": _rich_text_property(source.notes or ""),
    }


async def reconcile_source_registry(db: AsyncSession) -> int:
    api = get_notion_api()
    if api is None:
        return 0

    resources = await ensure_control_plane(db)
    registry = resources.get("source_registry") or {}
    data_source_id = registry.get("data_source_id")
    if not data_source_id:
        return 0

    pages = await api.query_all_pages(data_source_id)
    updated = 0

    for page in pages:
        page_id = page.get("id")
        if not page_id or page.get("in_trash"):
            continue

        source_type = _extract_prop_text(page, "Source Type") or "association"
        primary_url = _extract_prop_text(page, "Primary URL")
        secondary_urls = [
            line.strip()
            for line in _extract_prop_text(page, "Secondary URLs").splitlines()
            if line.strip()
        ]
        status = (_extract_prop_text(page, "Status") or "candidate").lower()
        backfill_status = (_extract_prop_text(page, "Initial Backfill Status") or "new").lower()
        notion_source = {
            "name": _extract_prop_text(page, "Name") or _get_page_title(page),
            "category": source_type,
            "fetch_strategy": _extract_prop_text(page, "Fetch Strategy") or "web_scrape",
            "url": primary_url or None,
            "secondary_urls": secondary_urls,
            "notes": _extract_prop_text(page, "Notes / Rationale") or None,
            "cadence_bucket": _extract_prop_text(page, "Cadence Bucket") or "daily",
            "discovery_mode": (_extract_prop_text(page, "Discovery Mode") or "manual").lower(),
            "notion_page_id": page_id,
            "onboarding_status": backfill_status,
            "is_active": status == "active",
            "last_ingested_at": _extract_prop_date(page, "Last Ingested At"),
            "next_ingest_at": _extract_prop_date(page, "Next Ingest At"),
        }

        stmt = select(Source).where(Source.notion_page_id == page_id)
        result = await db.execute(stmt)
        source = result.scalar_one_or_none()
        if source is None:
            source = Source(**notion_source)
            db.add(source)
        else:
            for key, value in notion_source.items():
                setattr(source, key, value)

        updated += 1

    await db.flush()
    return updated


async def sync_source_registry_to_notion(db: AsyncSession) -> int:
    api = get_notion_api()
    if api is None:
        return 0

    resources = await ensure_control_plane(db)
    registry = resources.get("source_registry") or {}
    data_source_id = registry.get("data_source_id")
    if not data_source_id:
        return 0

    result = await db.execute(select(Source).order_by(Source.updated_at.desc()))
    sources = result.scalars().all()
    synced = 0

    for source in sources:
        properties = build_source_registry_properties(source)
        if source.notion_page_id:
            await api.update_page(page_id=source.notion_page_id, properties=properties)
        else:
            page = await api.create_page(data_source_id=data_source_id, properties=properties)
            source.notion_page_id = page["id"]
        synced += 1

    await db.flush()
    return synced


async def sync_watch_targets_to_notion(db: AsyncSession) -> int:
    api = get_notion_api()
    if api is None:
        return 0

    resources = await ensure_control_plane(db)
    synced = 0
    stmt = (
        select(WatchTarget)
        .options(
            selectinload(WatchTarget.entity).selectinload(Entity.scores),
        )
        .order_by(WatchTarget.target_type.asc(), WatchTarget.score.desc())
    )
    result = await db.execute(stmt)
    targets = result.scalars().all()

    ranks: dict[str, int] = {"company": 0, "person": 0}
    for target in targets:
        entity = target.entity
        if entity is None:
            continue

        data_source_id = (
            resources.get("company_watchlist", {}).get("data_source_id")
            if target.target_type == "company"
            else resources.get("people_watchlist", {}).get("data_source_id")
        )
        if not data_source_id:
            continue

        ranks[target.target_type] += 1
        target.rank = ranks[target.target_type]
        score = entity.scores[-1] if entity.scores else None
        properties = {
            "Name": _title_property(entity.display_name),
            "Status": {"select": {"name": target.status or "active"}},
            "Score": {"number": round(target.score, 4)},
            "Rank": {"number": target.rank},
            "Summary": _rich_text_property(entity.description or ""),
            "Thesis Tags": _multi_select_property(entity.thesis_tags or []),
            "Source Count": {"number": score.source_count if score else entity.source_count},
            "Evidence Count": {"number": score.evidence_count if score else entity.finding_count},
            "First Seen": _date_property(entity.first_seen_at),
            "Last Seen": _date_property(entity.last_seen_at),
            "Canonical URL": {"url": entity.canonical_url},
            "Rationale": _rich_text_property(score.rationale if score and score.rationale else ""),
        }

        if target.notion_page_id:
            await api.update_page(page_id=target.notion_page_id, properties=properties)
        else:
            page = await api.create_page(data_source_id=data_source_id, properties=properties)
            target.notion_page_id = page["id"]
        target.published_at = datetime.now(timezone.utc)
        synced += 1

    await db.flush()
    return synced


async def sync_findings_to_ocean() -> int:
    api = get_notion_api()
    if api is None:
        logger.warning("notion_not_configured")
        return 0

    async with async_session_factory() as db:
        resources = await ensure_control_plane(db)
        ocean = resources.get("ocean") or {}
        data_source_id = ocean.get("data_source_id")
        if not data_source_id:
            logger.warning("notion_ocean_data_source_missing")
            return 0

        stmt = (
            select(Finding)
            .options(selectinload(Finding.evidence_items), selectinload(Finding.source))
            .where(Finding.notion_page_id.is_(None), Finding.status != "dismissed")
            .order_by(Finding.relevance_score.desc())
            .limit(50)
        )
        result = await db.execute(stmt)
        findings = result.scalars().all()
        synced = 0

        for finding in findings:
            properties = {
                "Name": _title_property(finding.title[:100]),
                "Status": {"select": {"name": finding.status.capitalize()}},
                "Score": {"number": round(finding.relevance_score, 2)},
                "Category": {"select": {"name": finding.category or "general"}},
                "Summary": _rich_text_property(finding.summary[:2000]),
                "Source": _rich_text_property(finding.source.name if finding.source else "Unknown"),
            }
            if finding.vertical_tags:
                properties["Verticals"] = _multi_select_property(finding.vertical_tags)
            if finding.evidence_items:
                properties["Evidence URL"] = {"url": finding.evidence_items[0].url}

            children = [
                {
                    "object": "block",
                    "type": "paragraph",
                    "paragraph": {
                        "rich_text": [{"type": "text", "text": {"content": finding.summary[:2000]}}],
                    },
                }
            ]
            page = await api.create_page(
                data_source_id=data_source_id,
                properties=properties,
                children=children,
            )
            finding.notion_page_id = page["id"]
            payload_hash = hashlib.sha256(f"notion:{finding.id}:{page['id']}".encode()).hexdigest()
            db.add(
                Notification(
                    finding_id=finding.id,
                    channel="notion",
                    channel_ref=page["id"],
                    payload_hash=payload_hash,
                )
            )
            synced += 1

        await db.commit()
        return synced


async def pull_status_updates() -> int:
    api = get_notion_api()
    if api is None:
        return 0

    updated = 0
    status_map = {
        "New": "new",
        "Reviewed": "reviewed",
        "Actionable": "actionable",
        "Dismissed": "dismissed",
        "Archived": "archived",
    }

    async with async_session_factory() as db:
        stmt = select(Finding).where(Finding.notion_page_id.is_not(None))
        result = await db.execute(stmt)
        findings = result.scalars().all()

        for finding in findings:
            if not finding.notion_page_id:
                continue
            page = await api.retrieve_page(finding.notion_page_id)
            notion_status = _extract_prop_text(page, "Status")
            mapped = status_map.get(notion_status)
            if mapped and mapped != finding.status:
                finding.status = mapped
                updated += 1

        await db.commit()
    return updated


async def run_full_notion_sync() -> dict[str, int]:
    async with async_session_factory() as db:
        control = await ensure_control_plane(db)
        registry = await sync_source_registry_to_notion(db)
        watchlists = await sync_watch_targets_to_notion(db)
        await db.commit()

    findings = await sync_findings_to_ocean()
    updates = await pull_status_updates()
    return {
        "control_plane": len(control),
        "source_registry": registry,
        "watchlists": watchlists,
        "findings": findings,
        "status_updates": updates,
    }


def parse_webhook_body(body: bytes) -> dict:
    if not body:
        return {}
    return json.loads(body.decode("utf-8"))
