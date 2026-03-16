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

## Company research and competition analysis

Observed recurring workflow from the transcript corpus:

- Team members ask Lexie to research a company before calls or as part of pipeline work.
- Typical requests: "tell us about [company] and how it's relevant to us",
  "validate these assumptions on competition analysis between [company A] and [company B]"
- Expected output: company overview, relevance to S3V thesis areas, funding status,
  regulatory context, competitive landscape.
- Use web search, Notion Pipeline Companies database, and existing artifacts as sources.
- Frame relevance against the S3V thesis (Identity & Permissioning, Wallets & Key Management,
  Compliance & Trust, Data Oracles & Middleware).

## Memory and backfill

- Durable facts go to `MEMORY.md`.
- Daily notes go to `memory/YYYY-MM-DD.md`.
- Transcript review inputs live under `knowledge/backfill/`.
- If a fact is not yet settled, quarantine it in a manifest rather than promoting it.
