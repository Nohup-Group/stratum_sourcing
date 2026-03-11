"""Snapshot diffing: detect new/changed content by comparing content hashes."""

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Snapshot

logger = structlog.get_logger()


async def compute_diff(
    db: AsyncSession,
    source_id: int,
    current_hash: str,
    current_content: str,
    run_id: int | None = None,
) -> str | None:
    """Compare current content against the most recent prior snapshot.

    Returns:
        The new content text if changed, or None if unchanged.
        For the first scan of a source, returns the full content.
    """
    # Find the most recent previous snapshot for this source, excluding the current run
    stmt = (
        select(Snapshot.content_hash)
        .where(
            Snapshot.source_id == source_id,
            Snapshot.content_hash != "",
            Snapshot.error.is_(None),
        )
    )
    if run_id is not None:
        stmt = stmt.where(Snapshot.run_id != run_id)

    stmt = stmt.order_by(Snapshot.fetched_at.desc()).limit(1)
    result = await db.execute(stmt)
    previous_hash = result.scalar_one_or_none()

    if previous_hash is None:
        # First ever scan for this source -- treat everything as new
        logger.info("first_scan", source_id=source_id)
        return current_content

    if previous_hash == current_hash:
        return None

    # Content has changed
    logger.info("content_changed", source_id=source_id, new_hash=current_hash[:12])
    return current_content
