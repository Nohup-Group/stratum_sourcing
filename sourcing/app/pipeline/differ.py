"""Snapshot diffing: detect new/changed content using block-level hashing.

Content from fetchers arrives as structured blocks (articles, entries) separated
by ``---`` or ``## `` headers.  Instead of hashing the entire page and sending
all 30 K chars to the LLM when a single byte changes, we:

1. Split the content into blocks.
2. Hash each block individually.
3. Compare block hashes against the previous snapshot.
4. Return **only the new / changed blocks** to the analyzer.

This dramatically reduces token usage for sources that append new items to an
otherwise-stable page (RSS feeds, newsletters, blog indexes, news pages).
"""

from __future__ import annotations

import re
from hashlib import sha256

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Snapshot

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# Block splitting
# ---------------------------------------------------------------------------

# Primary delimiter: the ``---`` separator that RSS and web fetchers emit
# between articles.  We also split on markdown ``## `` headers so that even
# non-delimited content gets reasonable blocks.
_BLOCK_SEP = re.compile(r"\n-{3,}\n|(?=\n## )")


def split_blocks(content: str) -> list[str]:
    """Split fetcher output into content blocks.

    Returns a list of non-empty, stripped blocks.
    """
    raw = _BLOCK_SEP.split(content)
    return [b.strip() for b in raw if b.strip()]


def hash_block(block: str) -> str:
    return sha256(block.encode("utf-8")).hexdigest()


def hash_blocks(blocks: list[str]) -> list[str]:
    return [hash_block(b) for b in blocks]


# ---------------------------------------------------------------------------
# Diff computation
# ---------------------------------------------------------------------------


async def compute_diff(
    db: AsyncSession,
    source_id: int,
    current_hash: str,
    current_content: str,
    run_id: int | None = None,
) -> str | None:
    """Compare current content against the most recent prior snapshot.

    Returns:
        The **new or changed** portion of content, or ``None`` if nothing
        changed.  For the first scan of a source, returns the full content.
    """
    # ---- fast path: overall hash unchanged → nothing to do ----
    stmt = (
        select(Snapshot.content_hash, Snapshot.metadata_)
        .where(
            Snapshot.source_id == source_id,
            Snapshot.content_hash != "",
            Snapshot.error.is_(None),
        )
    )
    if run_id is not None:
        stmt = stmt.where(Snapshot.run_id != run_id)

    stmt = stmt.order_by(Snapshot.fetched_at.desc()).limit(1)
    row = (await db.execute(stmt)).first()

    if row is None:
        # First ever scan – everything is new
        logger.info("first_scan", source_id=source_id)
        await _store_block_hashes(db, source_id, run_id, current_content)
        return current_content

    previous_hash, previous_meta = row

    if previous_hash == current_hash:
        return None

    # ---- block-level diff ----
    previous_block_hashes: set[str] = set(
        (previous_meta or {}).get("block_hashes") or []
    )

    current_blocks = split_blocks(current_content)

    if not current_blocks:
        logger.info("content_changed_no_blocks", source_id=source_id)
        await _store_block_hashes(db, source_id, run_id, current_content)
        return current_content

    current_hashes = hash_blocks(current_blocks)

    # Persist current block hashes for the next diff cycle
    await _store_block_hashes_raw(db, source_id, run_id, current_hashes)

    if not previous_block_hashes:
        # Previous snapshot didn't have block hashes (pre-migration) →
        # treat everything as new this one time.
        logger.info(
            "content_changed_no_prev_blocks",
            source_id=source_id,
            total_blocks=len(current_blocks),
        )
        return current_content

    # Keep only blocks whose hash is NOT in the previous set
    new_blocks = [
        block
        for block, h in zip(current_blocks, current_hashes)
        if h not in previous_block_hashes
    ]

    if not new_blocks:
        # Hashes differ at the page level (whitespace, timestamp, ad injection)
        # but every individual block is unchanged → skip LLM.
        logger.info(
            "content_changed_blocks_same",
            source_id=source_id,
            total_blocks=len(current_blocks),
        )
        return None

    diff_text = "\n\n---\n\n".join(new_blocks)

    logger.info(
        "block_diff",
        source_id=source_id,
        total_blocks=len(current_blocks),
        new_blocks=len(new_blocks),
        diff_chars=len(diff_text),
        full_chars=len(current_content),
        savings_pct=round(
            (1 - len(diff_text) / max(len(current_content), 1)) * 100, 1
        ),
    )
    return diff_text


# ---------------------------------------------------------------------------
# Helpers – store block hashes inside the current run's snapshot metadata
# ---------------------------------------------------------------------------


async def _store_block_hashes(
    db: AsyncSession,
    source_id: int,
    run_id: int | None,
    content: str,
) -> None:
    """Compute and store block hashes for *content* on the current snapshot."""
    blocks = split_blocks(content)
    hashes = hash_blocks(blocks)
    await _store_block_hashes_raw(db, source_id, run_id, hashes)


async def _store_block_hashes_raw(
    db: AsyncSession,
    source_id: int,
    run_id: int | None,
    hashes: list[str],
) -> None:
    """Persist pre-computed block hashes on the current snapshot's metadata."""
    if run_id is None:
        return
    stmt = (
        select(Snapshot)
        .where(Snapshot.source_id == source_id, Snapshot.run_id == run_id)
        .order_by(Snapshot.id.desc())
        .limit(1)
    )
    snap = (await db.execute(stmt)).scalar_one_or_none()
    if snap is not None:
        meta = dict(snap.metadata_ or {})
        meta["block_hashes"] = hashes
        snap.metadata_ = meta
