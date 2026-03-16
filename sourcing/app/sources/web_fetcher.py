"""Web scraper using httpx + BeautifulSoup.

Two-step fetch: scrape the index/blog page for article links, then fetch
each article to get full content and specific URLs for evidence.
"""

import asyncio
import json
import time
from urllib.parse import urljoin

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

# Selectors commonly used for article listing pages
ARTICLE_LINK_SELECTORS = [
    "article a[href]",
    ".post a[href]",
    ".blog-post a[href]",
    ".entry a[href]",
    "h2 a[href]",
    "h3 a[href]",
    ".card a[href]",
    ".news-item a[href]",
    ".list-item a[href]",
]


class WebFetcher(BaseFetcher):
    """Scrapes web pages using httpx + BeautifulSoup. Follows article links
    to get full content for analysis."""

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

        soup = BeautifulSoup(html, "lxml")

        # Remove noise
        for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
            tag.decompose()

        # Extract article links from the index page
        max_articles = config.get("max_articles", 5)
        link_selector = config.get("link_selector")
        article_links = self._extract_article_links(soup, url, link_selector, max_articles)

        if article_links:
            # Deep fetch: follow links to get full article content
            articles = await self._fetch_articles(article_links)
            title = soup.title.string.strip() if soup.title and soup.title.string else ""
            content = f"# {title}\nSource: {url}\n\n" + "\n---\n".join(articles)
        else:
            # Fallback: use the page content directly (single-page source)
            content_selector = config.get("content_selector")
            if content_selector:
                elements = soup.select(content_selector)
                if elements:
                    page_content = "\n\n---\n\n".join(
                        el.get_text(separator="\n", strip=True) for el in elements
                    )
                else:
                    page_content = self._extract_main_content(soup)
            else:
                page_content = self._extract_main_content(soup)

            title = soup.title.string.strip() if soup.title and soup.title.string else ""
            pub_date = self._extract_publish_date(soup)
            date_line = f"\nPublished: {pub_date}" if pub_date else ""
            content = f"# {title}\nSource: {url}{date_line}\n\n{page_content}"

        # Truncate very long content
        max_chars = config.get("max_chars", 50000)
        if len(content) > max_chars:
            content = content[:max_chars] + "\n\n[Content truncated]"

        duration = int((time.monotonic() - start) * 1000)

        return FetchResult.from_content(
            content=content,
            url=url,
            duration_ms=duration,
            metadata={
                "title": soup.title.string.strip() if soup.title and soup.title.string else "",
                "content_length": len(content),
                "articles_found": len(article_links),
            },
        )

    def _extract_article_links(
        self, soup: BeautifulSoup, base_url: str, custom_selector: str | None, max_links: int
    ) -> list[str]:
        """Extract unique article links from an index page."""
        seen = set()
        links = []

        selectors = [custom_selector] if custom_selector else ARTICLE_LINK_SELECTORS

        for selector in selectors:
            for a_tag in soup.select(selector):
                href = a_tag.get("href", "")
                if not href or href.startswith("#") or href.startswith("mailto:"):
                    continue

                full_url = urljoin(base_url, href)

                # Skip links that point back to the same page or are clearly not articles
                if full_url in seen or full_url == base_url:
                    continue
                # Skip common non-article paths
                skip_patterns = ["/tag/", "/category/", "/author/", "/page/", "/search", "/login", "/signup"]
                if any(p in full_url.lower() for p in skip_patterns):
                    continue

                seen.add(full_url)
                links.append(full_url)

                if len(links) >= max_links:
                    return links

        return links

    async def _fetch_articles(self, urls: list[str]) -> list[str]:
        """Fetch full content from each article URL."""
        tasks = [self._fetch_single_article(url) for url in urls]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        articles = []
        for url, result in zip(urls, results):
            if isinstance(result, Exception) or not result:
                logger.debug("article_fetch_skipped", url=url)
                continue
            articles.append(result)
        return articles

    async def _fetch_single_article(self, url: str) -> str | None:
        """Fetch a single article page and extract its content."""
        await self._rate_limit()

        try:
            resp = await self._client.get(url)
            resp.raise_for_status()
            html = resp.text
        except (httpx.HTTPError, Exception) as e:
            logger.debug("article_fetch_failed", url=url, error=str(e))
            return None

        soup = BeautifulSoup(html, "lxml")
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

        if not article_text or len(article_text) < 50:
            return None

        # Truncate per article
        if len(article_text) > 3000:
            article_text = article_text[:3000] + "..."

        title = soup.title.string.strip() if soup.title and soup.title.string else ""
        pub_date = self._extract_publish_date(soup)
        date_line = f"\nPublished: {pub_date}" if pub_date else ""

        return (
            f"## {title}\n"
            f"URL: {url}{date_line}\n\n"
            f"{article_text}\n"
        )

    @staticmethod
    def _extract_publish_date(soup: BeautifulSoup) -> str | None:
        """Try to extract a publication date from HTML metadata or <time> tags."""
        # 1. Open Graph / meta tags
        for attr in ["article:published_time", "datePublished", "date", "DC.date"]:
            tag = soup.find("meta", attrs={"property": attr}) or soup.find("meta", attrs={"name": attr})
            if tag and tag.get("content"):
                return tag["content"][:10]

        # 2. JSON-LD structured data
        for script in soup.find_all("script", type="application/ld+json"):
            try:
                data = json.loads(script.string or "")
                if isinstance(data, list):
                    data = data[0]
                for key in ["datePublished", "dateCreated"]:
                    if data.get(key):
                        return str(data[key])[:10]
            except (json.JSONDecodeError, TypeError, IndexError):
                pass

        # 3. <time> element with datetime attribute
        time_tag = soup.find("time", attrs={"datetime": True})
        if time_tag:
            return time_tag["datetime"][:10]

        return None

    def _extract_main_content(self, soup: BeautifulSoup) -> str:
        """Extract main content from the page, preferring article/main tags."""
        for selector in ["article", "main", "[role='main']", ".content", "#content", ".post"]:
            elements = soup.select(selector)
            if elements:
                return "\n\n".join(
                    el.get_text(separator="\n", strip=True) for el in elements
                )

        body = soup.find("body")
        if body:
            return body.get_text(separator="\n", strip=True)

        return soup.get_text(separator="\n", strip=True)

    async def close(self) -> None:
        await self._client.aclose()
