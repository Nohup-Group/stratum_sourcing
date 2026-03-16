# Recurring Workflows

## Inbox triage

Observed recurring workflow from the transcript corpus:

- Check the shared Gmail inbox.
- Ignore spam, newsletters, and routine calendar RSVP noise.
- Escalate via Slack only when something new or old is actually actionable.
- Stay quiet when there is nothing actionable.

## Artifact handling

- Start with `knowledge/artifacts/*.md` digests.
- Use raw files only when the digest is insufficient.
- Keep provenance attached to summaries and extracted facts.

## Notion support

- Use stored database ids and user ids from `knowledge/notion.md` and `TOOLS.md`.
- Retrieve live data for schema- or page-specific questions instead of guessing.

## Memory and backfill

- Durable facts go to `MEMORY.md`.
- Daily notes go to `memory/YYYY-MM-DD.md`.
- Transcript review inputs live under `knowledge/backfill/`.
- If a fact is not yet settled, quarantine it in a manifest rather than promoting it.
