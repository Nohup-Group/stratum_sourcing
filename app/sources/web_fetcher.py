"""Web scraper using httpx + BeautifulSoup."""

import asyncio
import time

import httpx
import structlog
from bs4 import BeautifulSoup

from app.sources.base import BaseFetcher, FetchResult

logger = structlog.get_logger()

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


class WebFetcher(BaseFetcher):
    """Scrapes web pages using httpx + BeautifulSoup. Used for company blogs,
    VC portfolio pages, conference agendas, and university research pages."""

    def __init__(self, timeout: int = 30, delay: float = 2.0):
        self._client = httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            headers=DEFAULT_HEADERS,
        )
        self._delay = delay
        self._last_request: float = 0

    async def _rate_limit(self) -> None:
        elapsed = time.monotonic() - self._last_request
        if elapsed < self._delay:
            await asyncio.sleep(self._delay - elapsed)
        self._last_request = time.monotonic()

    async def fetch(self, url: str, config: dict | None = None) -> FetchResult:
        config = config or {}
        await self._rate_limit()
        start = time.monotonic()

        try:
            response = await self._client.get(url)
            response.raise_for_status()
            html = response.text
        except httpx.HTTPError as e:
            duration = int((time.monotonic() - start) * 1000)
            logger.warning("web_fetch_failed", url=url, error=str(e))
            return FetchResult.from_error(url, str(e), duration)

        duration = int((time.monotonic() - start) * 1000)

        soup = BeautifulSoup(html, "lxml")

        # Remove script, style, nav, footer, header elements
        for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
            tag.decompose()

        # Use CSS selector if configured, otherwise extract main content
        content_selector = config.get("content_selector")
        if content_selector:
            elements = soup.select(content_selector)
            if elements:
                text_parts = [el.get_text(separator="\n", strip=True) for el in elements]
                content = "\n\n---\n\n".join(text_parts)
            else:
                logger.info("selector_no_match", url=url, selector=content_selector)
                content = self._extract_main_content(soup)
        else:
            content = self._extract_main_content(soup)

        # Truncate very long content
        max_chars = config.get("max_chars", 50000)
        if len(content) > max_chars:
            content = content[:max_chars] + "\n\n[Content truncated]"

        title = soup.title.string.strip() if soup.title and soup.title.string else ""

        return FetchResult.from_content(
            content=f"# {title}\nSource: {url}\n\n{content}",
            url=url,
            duration_ms=duration,
            metadata={"title": title, "content_length": len(content)},
        )

    def _extract_main_content(self, soup: BeautifulSoup) -> str:
        """Extract main content from the page, preferring article/main tags."""
        # Try common content containers in order of specificity
        for selector in ["article", "main", "[role='main']", ".content", "#content", ".post"]:
            elements = soup.select(selector)
            if elements:
                return "\n\n".join(
                    el.get_text(separator="\n", strip=True) for el in elements
                )

        # Fallback: get body text
        body = soup.find("body")
        if body:
            return body.get_text(separator="\n", strip=True)

        return soup.get_text(separator="\n", strip=True)

    async def close(self) -> None:
        await self._client.aclose()
