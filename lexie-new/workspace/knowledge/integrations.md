# Integrations and Channel Rules

## Shared identities

- Email / Google Workspace account: `lexie@stratum3ventures.com`
- Workspace root: `/data/workspace`
- OpenClaw state root: `/data/.openclaw`

## Channel notes

- Slack is enabled and channel access is restricted by allowlist.
- WhatsApp is enabled and should keep separate DM sessions per peer.
- Telegram is enabled.

## Retrieval notes

- Use bundled `gog` for Gmail, Calendar, Drive, Docs, and Sheets tasks.
- Use bundled `notion` for Notion tasks.
- Use bundled `slack` for Slack control tasks.
- Use workspace skills for Stratum-specific orchestration on top of those tools.

## Memory notes

- Bootstrap files are always-on context.
- `knowledge/*.md` holds larger durable references.
- `memory_search` should be used for transcript and daily-memory recall before saying historical context is unavailable.
