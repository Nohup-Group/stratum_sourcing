"""Deduplication: check if a finding already exists (by dedup_hash)."""

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Finding

logger = structlog.get_logger()


async def is_duplicate(db: AsyncSession, dedup_hash: str) -> bool:
    """Check if a finding with this dedup_hash already exists.

    The dedup_hash is SHA-256(normalized_title | source_id | date_bucket),
    ensuring the same finding from the same source on the same day is not
    created twice, even if the scan reruns.
    """
    stmt = select(Finding.id).where(Finding.dedup_hash == dedup_hash).limit(1)
    result = await db.execute(stmt)
    exists = result.scalar_one_or_none() is not None

    if exists:
        logger.debug("duplicate_finding", dedup_hash=dedup_hash[:12])

    return exists
