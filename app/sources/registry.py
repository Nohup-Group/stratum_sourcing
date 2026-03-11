"""Source fetcher registry: maps strategy names to fetcher instances."""

import structlog

from app.sources.base import BaseFetcher
from app.sources.browser_fetcher import BrowserFetcher
from app.sources.rss_fetcher import RSSFetcher
from app.sources.web_fetcher import WebFetcher

logger = structlog.get_logger()

# Singleton fetcher instances (shared across the scan run)
_fetchers: dict[str, BaseFetcher] = {}


def get_fetcher(strategy: str) -> BaseFetcher:
    """Get or create a fetcher instance for the given strategy."""
    if strategy not in _fetchers:
        match strategy:
            case "rss":
                _fetchers[strategy] = RSSFetcher()
            case "web_scrape":
                _fetchers[strategy] = WebFetcher()
            case "browser":
                _fetchers[strategy] = BrowserFetcher()
            case _:
                raise ValueError(f"Unknown fetch strategy: {strategy}")
    return _fetchers[strategy]


async def close_all_fetchers() -> None:
    """Close all fetcher instances and release resources."""
    for name, fetcher in _fetchers.items():
        try:
            await fetcher.close()
        except Exception as e:
            logger.warning("fetcher_close_error", fetcher=name, error=str(e))
    _fetchers.clear()
