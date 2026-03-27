"""Semantic pre-filter: skip irrelevant content blocks before LLM analysis.

Uses OpenRouter (qwen/qwen3-embedding-8b) to compute cosine similarity between
content and Stratum's investment thesis queries.  Blocks below the threshold
never reach the analyzer, saving LLM tokens.

Inspired by Agrana's multi-query semantic ranker pattern (semantic_ranker.py).

Cost: qwen3-embedding-8b on OpenRouter is $0.01 per 1M tokens — negligible
compared to the GPT-5 analyzer calls it prevents.
"""

from __future__ import annotations

import numpy as np
import structlog
import httpx

from app.config import settings

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# Thesis queries — one per vertical + general fund thesis
# These are embedded once (cached) and compared against every content block.
# ---------------------------------------------------------------------------

THESIS_QUERIES: list[str] = [
    # General fund thesis
    "European Seed or Series A startup building regulated tokenised market infrastructure at the intersection of traditional finance and decentralised finance",

    # Vertical 1: Identity & Permissioning
    "Digital identity verification, eID, eIDAS regulation, verifiable credentials, decentralised identity, access control for financial institutions, permissioned blockchain identity",

    # Vertical 2: Wallets & Key Management
    "Institutional crypto wallet, MPC custody solution, hardware security module, account abstraction, key management for digital assets, institutional custody infrastructure",

    # Vertical 3: Compliance & Trust Infrastructure
    "KYC KYB AML sanctions screening, regtech compliance automation, MiCA regulation implementation, DLT Pilot Regime, trust infrastructure for tokenised securities",

    # Vertical 4: Data, Oracles & Middleware
    "Blockchain oracle data feed, tokenisation rails middleware, cross-chain interoperability, settlement layer, asset tokenisation infrastructure, real world asset RWA bridge",

    # Cross-cutting signals
    "Funding round seed series A European fintech blockchain infrastructure startup",
    "Regulatory development digital assets tokenisation securities Europe MiCA eIDAS",
    "Partnership integration institutional adoption tokenised assets custody wallet compliance",
]

# Similarity threshold — blocks below this are skipped.
# 0.30 is conservative (keeps most relevant content, skips obvious noise).
# Agrana uses 0.35-0.40 for their B2B domain.
DEFAULT_THRESHOLD = 0.30

# ---------------------------------------------------------------------------
# Embedding provider config
# ---------------------------------------------------------------------------

_OPENROUTER_BASE = "https://openrouter.ai/api/v1"
_OPENAI_BASE = "https://api.openai.com/v1"

# ---------------------------------------------------------------------------
# Embedding cache
# ---------------------------------------------------------------------------

_thesis_embeddings: np.ndarray | None = None


def _get_embed_config() -> tuple[str, str, str]:
    """Return (base_url, api_key, model) for the embedding provider.

    Prefers OpenRouter (cheaper, Qwen3).  Falls back to OpenAI direct.
    """
    if settings.openrouter_api_key:
        return (
            _OPENROUTER_BASE,
            settings.openrouter_api_key,
            settings.embedding_model,
        )
    if settings.openai_api_key:
        return (
            _OPENAI_BASE,
            settings.openai_api_key,
            "text-embedding-3-small",
        )
    return ("", "", "")


async def _get_thesis_embeddings() -> np.ndarray:
    """Compute and cache thesis query embeddings."""
    global _thesis_embeddings
    if _thesis_embeddings is not None:
        return _thesis_embeddings

    _thesis_embeddings = await _embed_texts(THESIS_QUERIES)
    logger.info("thesis_embeddings_cached", queries=len(THESIS_QUERIES))
    return _thesis_embeddings


async def _embed_texts(texts: list[str]) -> np.ndarray:
    """Call embeddings API (OpenRouter or OpenAI) for a batch of texts."""
    base_url, api_key, model = _get_embed_config()
    if not api_key:
        raise RuntimeError("No embedding provider configured (set OPENROUTER_API_KEY or OPENAI_API_KEY)")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    # OpenRouter optional attribution headers
    if "openrouter" in base_url:
        headers["HTTP-Referer"] = "https://stratum3.vc"
        headers["X-OpenRouter-Title"] = "stratum-sourcing"

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{base_url}/embeddings",
            headers=headers,
            json={
                "model": model,
                "input": texts,
            },
        )
        resp.raise_for_status()
        data = resp.json()

    embeddings = []
    for item in sorted(data["data"], key=lambda x: x["index"]):
        v = np.array(item["embedding"], dtype=np.float32)
        norm = np.linalg.norm(v)
        if norm > 0:
            v /= norm  # L2 normalize
        embeddings.append(v)

    usage = data.get("usage", {})
    logger.info(
        "embeddings_computed",
        provider="openrouter" if "openrouter" in base_url else "openai",
        model=model,
        texts=len(texts),
        total_tokens=usage.get("total_tokens"),
    )
    return np.vstack(embeddings)


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Max cosine similarity between a single vector and a matrix of vectors."""
    # a: (dim,), b: (n, dim) — both L2-normalized, so dot product = cosine
    scores = b @ a
    return float(np.max(scores))


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def filter_blocks(
    blocks: list[str],
    threshold: float = DEFAULT_THRESHOLD,
) -> tuple[list[str], dict]:
    """Filter content blocks by thesis relevance.

    Args:
        blocks: List of content blocks (from the differ).
        threshold: Minimum cosine similarity to keep a block.

    Returns:
        (kept_blocks, stats) where stats contains filtering metrics.
    """
    base_url, api_key, _ = _get_embed_config()
    if not api_key:
        # No embedding provider — pass everything through
        return blocks, {"skipped": True, "reason": "no_api_key"}

    if not blocks:
        return blocks, {"skipped": True, "reason": "empty"}

    thesis_emb = await _get_thesis_embeddings()

    # Truncate blocks for embedding (save tokens — first ~2000 chars is
    # enough to judge relevance)
    truncated = [b[:2000] for b in blocks]
    block_emb = await _embed_texts(truncated)

    kept = []
    dropped = []
    scores = []

    for i, (block, emb) in enumerate(zip(blocks, block_emb)):
        score = _cosine_similarity(emb, thesis_emb)
        scores.append(round(score, 3))
        if score >= threshold:
            kept.append(block)
        else:
            first_line = block.split("\n")[0][:80]
            dropped.append({"index": i, "score": round(score, 3), "preview": first_line})

    stats = {
        "total_blocks": len(blocks),
        "kept": len(kept),
        "dropped": len(dropped),
        "threshold": threshold,
        "scores": scores,
        "dropped_details": dropped[:5],  # log at most 5
    }

    logger.info(
        "prefilter_result",
        total=len(blocks),
        kept=len(kept),
        dropped=len(dropped),
        threshold=threshold,
        scores=scores,
    )

    return kept, stats


# ---------------------------------------------------------------------------
# Pre-analysis dedup: skip blocks that match recent findings
# ---------------------------------------------------------------------------

PRE_DEDUP_THRESHOLD = 0.90
PRE_DEDUP_LOOKBACK_DAYS = 7
PRE_DEDUP_MAX_FINDINGS = 200


async def dedup_blocks_against_findings(
    db: "AsyncSession",
    blocks: list[str],
    source_id: int,
    threshold: float = PRE_DEDUP_THRESHOLD,
) -> tuple[list[str], dict]:
    """Drop content blocks that are semantically similar to recent findings.

    Compares each block against the title+summary of recent findings from OTHER
    sources.  If a block matches an existing finding above *threshold*, it's
    likely the same news and we can skip the expensive LLM analyzer call.

    Blocks that are NOT duplicates pass through to the analyzer as before.
    The post-analysis dedup (deduplicator.py) still runs as a safety net for
    the harder cases this misses.

    Args:
        db: Async database session.
        blocks: Content blocks that passed the relevance pre-filter.
        source_id: Current source ID (exclude its own findings from comparison).
        threshold: Cosine similarity threshold for dedup (default 0.90).

    Returns:
        (novel_blocks, stats)
    """
    from datetime import datetime, timedelta, timezone
    from sqlalchemy import select
    from app.models import Finding

    base_url, api_key, _ = _get_embed_config()
    if not api_key or not blocks:
        return blocks, {"skipped": True, "reason": "no_api_key" if not api_key else "empty"}

    # Fetch recent findings from OTHER sources
    since = datetime.now(timezone.utc) - timedelta(days=PRE_DEDUP_LOOKBACK_DAYS)
    stmt = (
        select(Finding.id, Finding.title, Finding.summary)
        .where(
            Finding.created_at >= since,
            Finding.source_id != source_id,
            Finding.status != "dismissed",
        )
        .order_by(Finding.relevance_score.desc())
        .limit(PRE_DEDUP_MAX_FINDINGS)
    )
    rows = (await db.execute(stmt)).all()

    if not rows:
        return blocks, {"skipped": True, "reason": "no_recent_findings"}

    # Embed existing findings (title + summary)
    finding_texts = [f"{r.title} {r.summary}" for r in rows]
    finding_embs = await _embed_texts([t[:500] for t in finding_texts])

    # Embed new blocks (truncated)
    block_embs = await _embed_texts([b[:2000] for b in blocks])

    novel = []
    duped = []

    for i, (block, b_emb) in enumerate(zip(blocks, block_embs)):
        # Max similarity against any existing finding
        scores = finding_embs @ b_emb
        max_sim = float(np.max(scores))
        max_idx = int(np.argmax(scores))

        if max_sim >= threshold:
            matched = rows[max_idx]
            first_line = block.split("\n")[0][:80]
            duped.append({
                "block_preview": first_line,
                "score": round(max_sim, 3),
                "matched_finding_id": matched.id,
                "matched_title": matched.title[:60],
            })
            logger.info(
                "pre_dedup_block_dropped",
                block_preview=first_line,
                score=round(max_sim, 3),
                matched_finding_id=matched.id,
                matched_title=matched.title[:60],
            )
        else:
            novel.append(block)

    stats = {
        "total_blocks": len(blocks),
        "novel": len(novel),
        "duplicates": len(duped),
        "threshold": threshold,
        "compared_against": len(rows),
        "duplicate_details": duped[:5],
    }

    logger.info(
        "pre_dedup_result",
        total=len(blocks),
        novel=len(novel),
        duplicates=len(duped),
        compared_against=len(rows),
    )

    return novel, stats
