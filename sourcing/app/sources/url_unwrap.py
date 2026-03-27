"""URL unwrapping: resolve tracking links, SafeLinks, and redirects.

Newsletter and feed URLs often pass through tracking wrappers (Outlook SafeLinks,
HubSpot, Mailchimp, Substack redirects) that obscure the actual destination.
Unwrapping these gives cleaner evidence URLs in findings.

Adapted from the Agrana pipeline (email_loader.py).
"""

from __future__ import annotations

import html
from urllib.parse import parse_qs, urlparse

import httpx
import structlog

logger = structlog.get_logger()

# Known tracking/wrapper domains
_SAFELINK_HOSTS = {"safelinks.protection.outlook.com"}
_TRACKING_PARAMS = {"utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "mc_cid", "mc_eid"}


def unwrap_url_sync(url: str) -> str:
    """Unwrap known tracking wrappers without making HTTP requests.

    Handles:
    - Microsoft SafeLinks (safelinks.protection.outlook.com)
    - HTML entity decoding
    - Stripping common tracking query params (UTM, Mailchimp)
    """
    # HTML entity decoding (e.g., &amp; → &)
    url = html.unescape(url)

    parsed = urlparse(url)

    # SafeLinks: extract the real URL from the ?url= parameter
    if parsed.netloc in _SAFELINK_HOSTS:
        params = parse_qs(parsed.query)
        if "url" in params:
            url = html.unescape(params["url"][0])
            parsed = urlparse(url)

    # Strip tracking params
    if parsed.query:
        from urllib.parse import urlencode, parse_qs as pqs

        params = pqs(parsed.query, keep_blank_values=False)
        cleaned = {k: v for k, v in params.items() if k.lower() not in _TRACKING_PARAMS}
        if cleaned:
            clean_query = urlencode(cleaned, doseq=True)
            url = parsed._replace(query=clean_query).geturl()
        else:
            url = parsed._replace(query="").geturl()

    return url


async def resolve_url(url: str, client: httpx.AsyncClient | None = None) -> str:
    """Unwrap + follow HTTP redirects to get the final destination URL.

    Use this sparingly (e.g., for evidence URLs) since it makes a HEAD request.
    """
    url = unwrap_url_sync(url)

    if client is None:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as c:
            return await _head_resolve(c, url)
    return await _head_resolve(client, url)


async def _head_resolve(client: httpx.AsyncClient, url: str) -> str:
    try:
        resp = await client.head(url)
        return str(resp.url)
    except Exception:
        return url
