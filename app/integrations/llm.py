"""LLM client abstraction supporting OpenAI (via OAuth minter) and Anthropic."""

import httpx
import structlog

from app.config import settings

logger = structlog.get_logger()

_cached_token: dict | None = None


async def _mint_oauth_token() -> str:
    """Get a fresh OAuth token from the minter service."""
    global _cached_token

    # Reuse cached token if still valid (tokens last 864000s = 10 days)
    if _cached_token and _cached_token.get("access_token"):
        return _cached_token["access_token"]

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{settings.oauth_minter_url}/mint",
            headers={"Authorization": f"Bearer {settings.oauth_minter_key}"},
        )
        resp.raise_for_status()
        _cached_token = resp.json()
        logger.info("oauth_token_minted", expires_in=_cached_token.get("expires_in"))
        return _cached_token["access_token"]


async def call_llm(
    prompt: str,
    system: str = "",
    max_tokens: int = 4096,
    temperature: float = 0.2,
    model: str | None = None,
) -> str:
    """Call LLM via OpenAI API (OAuth minter) or Anthropic API.

    Prefers OAuth minter if configured, falls back to Anthropic.
    """
    model = model or settings.llm_model

    if settings.oauth_minter_url and settings.oauth_minter_key:
        return await _call_openai(prompt, system, max_tokens, temperature, model)
    elif settings.anthropic_api_key:
        return await _call_anthropic(prompt, system, max_tokens, temperature, model)
    else:
        raise RuntimeError("No LLM credentials configured. Set OAUTH_MINTER_URL+KEY or ANTHROPIC_API_KEY.")


async def _call_openai(
    prompt: str, system: str, max_tokens: int, temperature: float, model: str
) -> str:
    """Call OpenAI API using OAuth-minted token."""
    token = await _mint_oauth_token()

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "model": model,
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
            },
        )
        resp.raise_for_status()
        data = resp.json()

    text = data["choices"][0]["message"]["content"]
    usage = data.get("usage", {})
    logger.debug(
        "llm_call",
        model=model,
        input_tokens=usage.get("prompt_tokens"),
        output_tokens=usage.get("completion_tokens"),
    )
    return text


async def _call_anthropic(
    prompt: str, system: str, max_tokens: int, temperature: float, model: str
) -> str:
    """Call Anthropic Claude API."""
    import anthropic

    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    response = await client.messages.create(
        model=model,
        max_tokens=max_tokens,
        temperature=temperature,
        system=system,
        messages=[{"role": "user", "content": prompt}],
    )

    text = response.content[0].text
    logger.debug(
        "llm_call",
        model=model,
        input_tokens=response.usage.input_tokens,
        output_tokens=response.usage.output_tokens,
    )
    return text
