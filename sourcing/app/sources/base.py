"""Abstract base fetcher and common data types."""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from hashlib import sha256


@dataclass
class FetchResult:
    content: str
    url: str
    content_hash: str
    fetched_at: datetime
    duration_ms: int
    error: str | None = None
    metadata: dict = field(default_factory=dict)

    @staticmethod
    def compute_hash(content: str) -> str:
        return sha256(content.encode("utf-8")).hexdigest()

    @classmethod
    def from_content(
        cls,
        content: str,
        url: str,
        duration_ms: int,
        metadata: dict | None = None,
    ) -> "FetchResult":
        return cls(
            content=content,
            url=url,
            content_hash=cls.compute_hash(content),
            fetched_at=datetime.now(timezone.utc),
            duration_ms=duration_ms,
            metadata=metadata or {},
        )

    @classmethod
    def from_error(cls, url: str, error: str, duration_ms: int = 0) -> "FetchResult":
        return cls(
            content="",
            url=url,
            content_hash="",
            fetched_at=datetime.now(timezone.utc),
            duration_ms=duration_ms,
            error=error,
        )


class BaseFetcher(ABC):
    """Abstract base class for all source fetchers."""

    @abstractmethod
    async def fetch(self, url: str, config: dict | None = None) -> FetchResult:
        """Fetch content from the given URL.

        Args:
            url: The URL to fetch.
            config: Source-specific configuration (CSS selectors, auth hints, etc.)

        Returns:
            FetchResult with content and metadata.
        """
        ...

    async def close(self) -> None:
        """Clean up resources (override if needed)."""
        pass
