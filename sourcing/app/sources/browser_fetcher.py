"""Browser-based fetcher using Playwright for JS-heavy and authenticated pages."""

import asyncio
import time
from pathlib import Path

import structlog

from app.config import settings
from app.sources.base import BaseFetcher, FetchResult

logger = structlog.get_logger()


class BrowserFetcher(BaseFetcher):
    """Uses Playwright with persistent browser context for LinkedIn and JS-heavy pages.

    Session state (cookies, localStorage) is stored on the persistent volume
    so it survives container redeploys.
    """

    def __init__(self, rate_limit_seconds: float | None = None):
        self._playwright = None
        self._browser = None
        self._context = None
        self._rate_limit = rate_limit_seconds or settings.browser_rate_limit_seconds
        self._last_request: float = 0
        self._consecutive_failures: int = 0
        self._circuit_open: bool = False
        self._max_failures: int = 3

    async def _ensure_browser(self) -> None:
        if self._context is not None:
            return

        from playwright.async_api import async_playwright

        self._playwright = await async_playwright().start()

        # Persistent context stores cookies/localStorage on disk
        user_data_dir = Path(settings.data_dir) / "browser" / "profile"
        user_data_dir.mkdir(parents=True, exist_ok=True)

        self._context = await self._playwright.chromium.launch_persistent_context(
            user_data_dir=str(user_data_dir),
            headless=True,
            viewport={"width": 1280, "height": 720},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
            locale="en-US",
            timezone_id="Europe/Berlin",
        )

    async def _apply_rate_limit(self) -> None:
        elapsed = time.monotonic() - self._last_request
        if elapsed < self._rate_limit:
            await asyncio.sleep(self._rate_limit - elapsed)
        self._last_request = time.monotonic()

    async def fetch(self, url: str, config: dict | None = None) -> FetchResult:
        config = config or {}

        # Circuit breaker
        if self._circuit_open:
            return FetchResult.from_error(
                url, "Circuit breaker open: too many consecutive failures"
            )

        await self._apply_rate_limit()
        start = time.monotonic()

        try:
            await self._ensure_browser()

            page = await self._context.new_page()
            try:
                # Navigate with timeout
                timeout_ms = config.get("timeout_ms", 30000)
                await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)

                # Wait for content to render
                wait_selector = config.get("wait_selector")
                if wait_selector:
                    await page.wait_for_selector(wait_selector, timeout=10000)
                else:
                    await asyncio.sleep(2)  # Default wait for JS rendering

                # Scroll down to trigger lazy loading (useful for feeds)
                scroll_count = config.get("scroll_count", 2)
                for _ in range(scroll_count):
                    await page.evaluate("window.scrollBy(0, window.innerHeight)")
                    await asyncio.sleep(1)

                # Extract content
                content_selector = config.get("content_selector")
                if content_selector:
                    elements = await page.query_selector_all(content_selector)
                    texts = []
                    for el in elements:
                        text = await el.inner_text()
                        if text.strip():
                            texts.append(text.strip())
                    content = "\n\n---\n\n".join(texts)
                else:
                    # Get main page text
                    content = await page.inner_text("body")

                title = await page.title()

                # Truncate
                max_chars = config.get("max_chars", 50000)
                if len(content) > max_chars:
                    content = content[:max_chars] + "\n\n[Content truncated]"

            finally:
                await page.close()

            duration = int((time.monotonic() - start) * 1000)
            self._consecutive_failures = 0

            return FetchResult.from_content(
                content=f"# {title}\nSource: {url}\n\n{content}",
                url=url,
                duration_ms=duration,
                metadata={"title": title, "method": "browser"},
            )

        except Exception as e:
            duration = int((time.monotonic() - start) * 1000)
            self._consecutive_failures += 1
            if self._consecutive_failures >= self._max_failures:
                self._circuit_open = True
                logger.error(
                    "browser_circuit_open",
                    url=url,
                    failures=self._consecutive_failures,
                )
            logger.warning("browser_fetch_failed", url=url, error=str(e))
            return FetchResult.from_error(url, str(e), duration)

    async def close(self) -> None:
        if self._context:
            await self._context.close()
            self._context = None
        if self._playwright:
            await self._playwright.stop()
            self._playwright = None
