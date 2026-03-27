"""Client for dispatching internal ops prompts through lexie-new or local LLM fallback."""

from __future__ import annotations

import json
import re

import httpx
import structlog

from app.config import settings
from app.integrations.llm import call_llm

logger = structlog.get_logger()


def _extract_json_block(text: str) -> dict:
    stripped = text.strip()
    candidates = [stripped]

    fenced_match = re.search(r"```(?:json)?\s*(\{.*\})\s*```", stripped, re.DOTALL)
    if fenced_match:
        candidates.append(fenced_match.group(1))

    object_match = re.search(r"(\{.*\})", stripped, re.DOTALL)
    if object_match:
        candidates.append(object_match.group(1))

    for candidate in candidates:
        try:
            value = json.loads(candidate)
            if isinstance(value, dict):
                return value
        except json.JSONDecodeError:
            continue

    raise ValueError("Ops response did not contain a valid JSON object")


async def run_ops_prompt(
    *,
    agent: str,
    system_prompt: str,
    user_prompt: str,
    timeout_seconds: int = 120,
    caller: str = "",
) -> str:
    """Run a prompt via lexie-new's internal ops endpoint, or fall back to the local LLM."""
    if settings.lexie_ops_url:
        url = settings.lexie_ops_url.rstrip("/") + "/api/ops/agent-jobs"
        headers = {"content-type": "application/json"}
        if settings.lexie_ops_token:
            headers["authorization"] = f"Bearer {settings.lexie_ops_token}"

        payload = {
            "agent": agent,
            "systemPrompt": system_prompt,
            "userPrompt": user_prompt,
            "timeoutMs": timeout_seconds * 1000,
        }

        resolved_caller = caller or f"ops:{agent}"
        logger.info(
            "ops_request",
            agent=agent,
            caller=resolved_caller,
            prompt_chars=len(user_prompt),
            system_chars=len(system_prompt),
        )
        async with httpx.AsyncClient(timeout=timeout_seconds + 5) as client:
            response = await client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            data = response.json()
            output_text = data.get("outputText", "").strip()
            if output_text:
                logger.info(
                    "ops_response",
                    agent=agent,
                    caller=resolved_caller,
                    response_chars=len(output_text),
                )
                return output_text
            raise RuntimeError("Lexie ops endpoint returned an empty response")

    resolved_caller = caller or f"ops:{agent}"
    logger.info("lexie_ops_fallback_local_llm", agent=agent, caller=resolved_caller)
    return await call_llm(
        prompt=user_prompt,
        system=system_prompt,
        max_tokens=4096,
        temperature=0.2,
        caller=resolved_caller,
    )


async def run_ops_json_prompt(
    *,
    agent: str,
    system_prompt: str,
    user_prompt: str,
    timeout_seconds: int = 120,
    caller: str = "",
) -> dict:
    text = await run_ops_prompt(
        agent=agent,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        timeout_seconds=timeout_seconds,
        caller=caller,
    )
    return _extract_json_block(text)
