"""RSS/Atom feed fetcher using feedparser.

Two-step fetch: parse the feed for recent entries, then fetch the full article
content for each entry so the analyzer gets real article text and specific URLs.
"""

import asyncio
import time
from datetime import datetime, timedelta, timezone

import feedparser
import httpx
import structlog
from bs4 import BeautifulSoup

from app.sources.base import BaseFetcher, FetchResult

logger = structlog.get_logger()

# How far back to look for "recent" entries
MAX_ENTRY_AGE_DAYS = 7


class RSSFetcher(BaseFetcher):
    """Fetches and parses RSS/Atom feeds, then follows links to get full article content."""

    def __init__(self, timeout: int = 30):
        self._client = httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                ),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
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

        feed = feedparser.parse(raw)
        if feed.bozo and not feed.entries:
            duration = int((time.monotonic() - start) * 1000)
            return FetchResult.from_error(url, f"Feed parse error: {feed.bozo_exception}", duration)

        # Filter to recent entries only
        max_entries = config.get("max_entries", 10)
        cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_ENTRY_AGE_DAYS)
        recent_entries = []
        for entry in feed.entries:
            pub_date = self._parse_entry_date(entry)
            if pub_date and pub_date < cutoff:
                continue
            recent_entries.append(entry)
            if len(recent_entries) >= max_entries:
                break

        if not recent_entries:
            # Fall back to the most recent entries if date parsing failed
            recent_entries = feed.entries[:max_entries]

        # Fetch full article content for each recent entry
        fetch_full = config.get("fetch_full_articles", True)
        if fetch_full:
            articles = await self._fetch_articles(recent_entries)
        else:
            articles = self._entries_to_summaries(recent_entries)

        content = f"# Feed: {feed.feed.get('title', url)}\n\n" + "\n---\n".join(articles)
        duration = int((time.monotonic() - start) * 1000)

        return FetchResult.from_content(
            content=content,
            url=url,
            duration_ms=duration,
            metadata={
                "feed_title": feed.feed.get("title", ""),
                "entry_count": len(feed.entries),
                "recent_entries": len(recent_entries),
                "full_articles_fetched": fetch_full,
            },
        )

    async def _fetch_articles(self, entries: list) -> list[str]:
        """Fetch full article content for each entry, falling back to RSS summary."""
        tasks = [self._fetch_single_article(entry) for entry in entries]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        articles = []
        for entry, result in zip(entries, results):
            if isinstance(result, Exception) or not result:
                # Fall back to RSS summary
                articles.append(self._entry_to_summary(entry))
            else:
                articles.append(result)
        return articles

    @staticmethod
    def _get_entry_link(entry: dict) -> str:
        """Get the best web URL from an RSS entry, skipping audio/video links."""
        # Try the standard link field first
        link = entry.get("link", "").strip()
        if link and not link.endswith((".mp3", ".mp4", ".m4a", ".ogg", ".wav")):
            return link

        # Check links array for a web link (not enclosure)
        for link_obj in entry.get("links", []):
            href = link_obj.get("href", "")
            link_type = link_obj.get("type", "")
            rel = link_obj.get("rel", "")
            if href and rel != "enclosure" and not link_type.startswith(("audio/", "video/")):
                return href

        # No usable web URL
        return ""

    async def _fetch_single_article(self, entry: dict) -> str | None:
        """Fetch and extract article text from an entry's link."""
        link = self._get_entry_link(entry)
        if not link:
            return None

        try:
            resp = await self._client.get(link)
            resp.raise_for_status()
            html = resp.text
        except (httpx.HTTPError, Exception) as e:
            logger.debug("article_fetch_failed", url=link, error=str(e))
            return None

        soup = BeautifulSoup(html, "lxml")

        # Remove noise
        for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
            tag.decompose()

        # Extract article content
        article_text = ""
        for selector in ["article", "main", "[role='main']", ".post-content", ".entry-content", ".article-body"]:
            elements = soup.select(selector)
            if elements:
                article_text = "\n\n".join(el.get_text(separator="\n", strip=True) for el in elements)
                break

        if not article_text:
            body = soup.find("body")
            if body:
                article_text = body.get_text(separator="\n", strip=True)

        # Truncate
        if len(article_text) > 3000:
            article_text = article_text[:3000] + "..."

        title = entry.get("title", "")
        published = entry.get("published", "")

        return (
            f"## {title}\n"
            f"URL: {link}\n"
            f"Published: {published}\n\n"
            f"{article_text}\n"
        )

    def _entry_to_summary(self, entry: dict) -> str:
        """Format a single RSS entry as text (fallback when full fetch fails)."""
        title = entry.get("title", "")
        link = self._get_entry_link(entry)
        published = entry.get("published", "")
        summary = entry.get("summary", "")
        if summary:
            summary = BeautifulSoup(summary, "html.parser").get_text(separator=" ", strip=True)
            if len(summary) > 1000:
                summary = summary[:1000] + "..."

        url_line = f"URL: {link}\n" if link else ""
        return (
            f"## {title}\n"
            f"{url_line}"
            f"Published: {published}\n"
            f"{summary}\n"
        )

    def _entries_to_summaries(self, entries: list) -> list[str]:
        return [self._entry_to_summary(e) for e in entries]

    @staticmethod
    def _parse_entry_date(entry: dict) -> datetime | None:
        """Try to parse the published date from an RSS entry."""
        # feedparser normalizes dates into published_parsed (time.struct_time)
        parsed = entry.get("published_parsed")
        if parsed:
            try:
                from calendar import timegm
                return datetime.fromtimestamp(timegm(parsed), tz=timezone.utc)
            except (ValueError, OverflowError):
                pass
        return None

    async def close(self) -> None:
        await self._client.aclose()
