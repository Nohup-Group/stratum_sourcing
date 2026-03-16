"""Compatibility wrapper around the Notion control-plane service."""

from app.services.notion_control import pull_status_updates, run_full_notion_sync, sync_findings_to_ocean


async def sync_findings_to_notion() -> int:
    return await sync_findings_to_ocean()


__all__ = ["pull_status_updates", "run_full_notion_sync", "sync_findings_to_notion"]
