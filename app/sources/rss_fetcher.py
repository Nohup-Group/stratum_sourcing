"""RSS/Atom feed fetcher using feedparser."""

import time

import feedparser
import httpx
import structlog

from app.sources.base import BaseFetcher, FetchResult

logger = structlog.get_logger()


class RSSFetcher(BaseFetcher):
    """Fetches and parses RSS/Atom feeds. Used for newsletters and regulatory feeds."""

    def __init__(self, timeout: int = 30):
        self._client = httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            headers={"User-Agent": "StratumSourcingBot/0.1 (+https://stratum3v.com)"},
        )

    async def fetch(self, url: str, config: dict | None = None) -> FetchResult:
        config = config or {}
        start = time.monotonic()

        try:
            response = await self._client.get(url)
            response.raise_for_status()
            raw = response.text
        except httpx.HTTPError as e:
            duration = int((time.monotonic() - start) * 1000)
            logger.warning("rss_fetch_failed", url=url, error=str(e))
            return FetchResult.from_error(url, str(e), duration)

        duration = int((time.monotonic() - start) * 1000)

        feed = feedparser.parse(raw)
        if feed.bozo and not feed.entries:
            return FetchResult.from_error(url, f"Feed parse error: {feed.bozo_exception}", duration)

        # Extract entries into normalized text
        max_entries = config.get("max_entries", 20)
        entries_text = []
        for entry in feed.entries[:max_entries]:
            title = entry.get("title", "")
            link = entry.get("link", "")
            published = entry.get("published", "")
            summary = entry.get("summary", "")
            # Strip HTML tags from summary
            if summary:
                from bs4 import BeautifulSoup

                summary = BeautifulSoup(summary, "html.parser").get_text(separator=" ", strip=True)
                # Truncate long summaries
                if len(summary) > 1000:
                    summary = summary[:1000] + "..."

            entries_text.append(
                f"## {title}\n"
                f"Link: {link}\n"
                f"Published: {published}\n"
                f"{summary}\n"
            )

        content = f"# Feed: {feed.feed.get('title', url)}\n\n" + "\n---\n".join(entries_text)

        return FetchResult.from_content(
            content=content,
            url=url,
            duration_ms=duration,
            metadata={
                "feed_title": feed.feed.get("title", ""),
                "entry_count": len(feed.entries),
                "entries_parsed": min(len(feed.entries), max_entries),
            },
        )

    async def close(self) -> None:
        await self._client.aclose()
