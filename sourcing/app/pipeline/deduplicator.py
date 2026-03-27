"""Deduplication: hash-based exact dedup + embedding-based semantic dedup.

Two layers:
1. Hash dedup (fast): SHA-256(title|source_id|date) — catches exact same finding from same source
2. Semantic dedup (slower): cosine similarity of title+summary embeddings — catches same news
   from different sources with different wording (threshold: 0.92)
"""

import hashlib
import math
import re
from datetime import datetime, timedelta, timezone

import httpx
import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import Finding

logger = structlog.get_logger()

SEMANTIC_THRESHOLD = 0.92
LOOKBACK_DAYS = 7


async def is_duplicate(db: AsyncSession, dedup_hash: str) -> bool:
    """Check if a finding with this dedup_hash already exists (exact match)."""
    stmt = select(Finding.id).where(Finding.dedup_hash == dedup_hash).limit(1)
    result = await db.execute(stmt)
    exists = result.scalar_one_or_none() is not None

    if exists:
        logger.debug("duplicate_finding_hash", dedup_hash=dedup_hash[:12])

    return exists


# Cache for batched recent-finding embeddings (rebuilt per scan run)
_recent_findings_cache: dict[str, tuple[list, "np.ndarray | None"]] = {}
_RECENT_CACHE_KEY = "recent"


async def _get_recent_embeddings(
    db: AsyncSession, source_id: int
) -> tuple[list, "np.ndarray | None"]:
    """Batch-embed recent findings from other sources.  Cached per scan run."""
    import numpy as np

    cache_key = f"{_RECENT_CACHE_KEY}:{source_id}"
    if cache_key in _recent_findings_cache:
        return _recent_findings_cache[cache_key]

    since = datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)
    stmt = (
        select(Finding.id, Finding.title, Finding.summary, Finding.source_id)
        .where(
            Finding.created_at >= since,
            Finding.source_id != source_id,
            Finding.status != "dismissed",
        )
        .order_by(Finding.relevance_score.desc())
        .limit(200)
    )
    recent = (await db.execute(stmt)).all()

    if not recent:
        _recent_findings_cache[cache_key] = ([], None)
        return [], None

    # Batch embed all at once (1 API call instead of 200)
    texts = [_normalize_text(f"{r.title} {r.summary}")[:500] for r in recent]
    emb_matrix = await _batch_embed(texts)

    _recent_findings_cache[cache_key] = (recent, emb_matrix)
    return recent, emb_matrix


async def _batch_embed(texts: list[str]) -> "np.ndarray | None":
    """Batch-embed a list of texts using OpenRouter or OpenAI."""
    import numpy as np

    if settings.openrouter_api_key:
        base_url = "https://openrouter.ai/api/v1"
        api_key = settings.openrouter_api_key
        model = settings.embedding_model
        extra_headers = {
            "HTTP-Referer": "https://stratum3.vc",
            "X-OpenRouter-Title": "stratum-sourcing",
        }
    elif settings.openai_api_key:
        base_url = "https://api.openai.com/v1"
        api_key = settings.openai_api_key
        model = "text-embedding-3-small"
        extra_headers = {}
    else:
        return None

    try:
        headers = {"Authorization": f"Bearer {api_key}", **extra_headers}
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{base_url}/embeddings",
                headers=headers,
                json={"model": model, "input": texts},
            )
            resp.raise_for_status()
            data = resp.json()

        vecs = []
        for item in sorted(data["data"], key=lambda x: x["index"]):
            v = np.array(item["embedding"], dtype=np.float32)
            norm = np.linalg.norm(v)
            if norm > 0:
                v /= norm
            vecs.append(v)
        return np.vstack(vecs)

    except Exception as e:
        logger.warning("batch_embed_failed", error=str(e))
        return None


async def is_semantic_duplicate(
    db: AsyncSession,
    title: str,
    summary: str,
    source_id: int,
) -> bool:
    """Check if a semantically similar finding exists from a different source.

    Uses batched embedding cosine similarity (1 API call for all recent findings,
    cached per scan run) instead of embedding each finding individually.

    Returns True if a finding with similarity > SEMANTIC_THRESHOLD exists
    from a different source within the lookback window.
    """
    import numpy as np

    new_text = _normalize_text(f"{title} {summary}")
    if not new_text:
        return False

    recent, emb_matrix = await _get_recent_embeddings(db, source_id)
    if not recent or emb_matrix is None:
        # No embeddings available — fall back to TF-IDF
        return _tfidf_duplicate(title, summary, recent)

    # Embed the new finding (single text — may hit cache)
    new_embedding = await _get_embedding(new_text)
    if new_embedding is None:
        return _tfidf_duplicate(title, summary, recent)

    new_vec = np.array(new_embedding, dtype=np.float32)
    norm = np.linalg.norm(new_vec)
    if norm > 0:
        new_vec /= norm

    # Vectorized comparison: one dot product against all recent embeddings
    scores = emb_matrix @ new_vec
    max_sim = float(np.max(scores))
    max_idx = int(np.argmax(scores))

    if max_sim >= SEMANTIC_THRESHOLD:
        matched = recent[max_idx]
        logger.info(
            "semantic_duplicate_found",
            new_title=title[:60],
            existing_id=matched.id,
            existing_title=matched.title[:60],
            similarity=round(max_sim, 4),
        )
        return True

    return False


def _tfidf_duplicate(title: str, summary: str, recent: list) -> bool:
    """Fallback TF-IDF dedup when embeddings are unavailable."""
    if not recent:
        return False
    new_tokens = _tokenize(_normalize_text(f"{title} {summary}"))
    for row in recent:
        existing_text = _normalize_text(f"{row.title} {row.summary}")
        existing_tokens = _tokenize(existing_text)
        sim = _jaccard_similarity(new_tokens, existing_tokens)
        if sim >= 0.65:
            logger.info(
                "semantic_duplicate_found_tfidf",
                new_title=title[:60],
                existing_id=row.id,
                existing_title=row.title[:60],
                similarity=round(sim, 4),
            )
            return True
    return False


# --- Embedding helpers ---

# Simple in-memory cache to avoid re-embedding the same text within a scan
_embedding_cache: dict[str, list[float]] = {}
_CACHE_MAX = 500


async def _get_embedding(text: str) -> list[float] | None:
    """Get embedding vector for text. Returns None if no embedding API available.

    Uses OpenRouter (Qwen3) if available, falls back to OpenAI.
    """
    cache_key = hashlib.md5(text.encode()).hexdigest()
    if cache_key in _embedding_cache:
        return _embedding_cache[cache_key]

    # Determine provider: prefer OpenRouter, fall back to OpenAI
    if settings.openrouter_api_key:
        base_url = "https://openrouter.ai/api/v1"
        api_key = settings.openrouter_api_key
        model = settings.embedding_model
        extra_headers = {
            "HTTP-Referer": "https://stratum3.vc",
            "X-OpenRouter-Title": "stratum-sourcing",
        }
    elif settings.openai_api_key:
        base_url = "https://api.openai.com/v1"
        api_key = settings.openai_api_key
        model = "text-embedding-3-small"
        extra_headers = {}
    else:
        return None

    try:
        headers = {"Authorization": f"Bearer {api_key}", **extra_headers}
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{base_url}/embeddings",
                headers=headers,
                json={
                    "model": model,
                    "input": text[:8000],
                },
            )
            resp.raise_for_status()
            data = resp.json()
            embedding = data["data"][0]["embedding"]

            # Cache it
            if len(_embedding_cache) < _CACHE_MAX:
                _embedding_cache[cache_key] = embedding

            return embedding

    except Exception as e:
        logger.debug("embedding_failed", error=str(e))
        return None


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two vectors."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


# --- Fallback: word-level similarity (no API needed) ---


def _normalize_text(text: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace."""
    text = text.lower()
    text = re.sub(r"[^\w\s]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


# Common English stop words to filter out
_STOP_WORDS = frozenset(
    "a an the and or but in on at to for of is it its this that with from by as are was were "
    "be been being have has had do does did will would could should may might can shall not no "
    "so if then than more also very just about up out into over after before between through "
    "during without within along across against until while since when where how what which who "
    "whom their there here these those each every all both few many much some any other another".split()
)


def _tokenize(text: str) -> set[str]:
    """Tokenize text into a set of meaningful words (stop words removed)."""
    words = text.split()
    return {w for w in words if w not in _STOP_WORDS and len(w) > 2}


def _jaccard_similarity(a: set[str], b: set[str]) -> float:
    """Jaccard similarity between two token sets."""
    if not a or not b:
        return 0.0
    intersection = a & b
    union = a | b
    return len(intersection) / len(union)


def clear_embedding_cache() -> None:
    """Clear the in-memory embedding cache (call between scan runs)."""
    _embedding_cache.clear()
    _recent_findings_cache.clear()
