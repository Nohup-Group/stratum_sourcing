# Column-width audit — stratum_sourcing @ c55b509

Byproduct of `docs/contracts/column-widths.json`, the machine-readable contract a test
should consume. This file is a human-readable summary only; do not hand-transcribe
values from here — read the JSON.

## What this is

Every `String(n)` `mapped_column` in `app/models.py` (37 of them), traced back to
every writer found in `app/services/`, `app/pipeline/`, `app/tasks/`, `app/api/`,
`scripts/`, and `alembic/versions/`, classified by where the value comes from and
whether an over-length value can reach the column un-truncated.

## Coverage

- 37 String(n) columns enumerated, all 37 traced to at least one writer or confirmed
  to have none.
- 36 columns have an explicit application-level writer; 1 (`evidence.content_type`)
  has none anywhere in the corpus and always takes its column default.
- 35 files fully read, 14 grep-checked and confirmed to touch no ORM model, 12 not
  examined (tests, unrelated JS shim, `alembic/env.py`, `database.py`, `llm.py`, and
  four `scripts/sourcing_run/*.py` tools with no DB-write grep hits).
- No unresolved alembic-vs-model drift: `signal_scans.band` was widened 20→30 in
  migration 006 and matches the model; `scan_runs.status` was widened 20→30 in
  migration 002 and matches the model; `role_hint` was widened to `Text` in
  migration 007 (the motivating bug) and matches the model.

## Decision tally

| decision | count |
|---|---|
| ok_internal | 20 |
| must_truncate | 10 |
| ok_bounded | 7 |
| must_widen | 1 |
| unknown | 0 |

## The one `must_widen`: signal_results.result

`String(12)`, but the code's own fixed result vocabulary includes `not_applicable`
(14 characters) — a value the column cannot hold regardless of where it came from.
Two writers can produce it: the live signal-scan pipeline
(`app/services/signal_engine.py:176,371-372,471`) and a one-off import script
(`scripts/sourcing_run/import_to_db.py:131,368-382`) that already ran against
production once under provenance tag `stratum3-manual-scan-2026-07-30`. This is
the same failure class as the motivating `role_hint` bug, except the offending
value isn't LLM prose — it's a string literal in the codebase that's simply too
long for its own column.

## The 10 `must_truncate`: LLM/external text with no length guard

- `entities.display_name`, `entities.normalized_name`, `entity_mentions.mention_text`
  — the three columns named in the task brief as "the same shape" as `role_hint`.
  All three receive an un-truncated LLM-extracted entity name
  (`app/services/agent_pipeline.py:298` → `:206,207,216,343`), while neighboring
  fields in the same function (`description`, `context_excerpt`) are already
  truncated with `[:500]`.
- `findings.category` — `RawFinding.category` (`app/pipeline/analyzer.py:30`) is an
  unconstrained Pydantic `str` even though the system prompt asks for one of 8
  short tokens; nothing enforces either the vocabulary or a length bound before
  `app/pipeline/orchestrator.py:303` writes it.
- `sources.name`, `sources.discovery_mode`, `sources.cadence_bucket`,
  `sources.onboarding_status` — all four are writable via `POST /api/sources`,
  which has **no auth dependency** (`app/api/routes.py:63-80`) and a Pydantic
  schema (`app/schemas.py:10-27`) with no `max_length` anywhere. Also reachable,
  for the same four fields, via the Notion "select" property sync path
  (`app/services/notion_control.py:426-459`), since Notion lets a user type a new
  select option of arbitrary length.
- `entities.domain`, `entities.registry_id` — no writer exists anywhere in the live
  `app/` tree; the only writer is the offline `scripts/sourcing_run/import_to_db.py`,
  which writes external research-data fields with no truncation.

## Open questions (4, written to the contract's `open_questions` array — not resolved here)

1. **Highest priority**: should `signal_results.result` be widened, or should the
   `not_applicable` token be shortened in code? (see must_widen section above)
2. Should `POST /api/sources`'s four unguarded string fields get `max_length`,
   full enum/`Literal` validation, or route auth — three different fixes for
   three different failure modes bundled into one gap.
3. Is `scripts/sourcing_run/import_to_db.py` in scope for this kind of contract at
   all? It's the only writer for 2 columns and a second writer for a 3rd, but it's
   manually invoked, not part of the always-running service.
4. Out of scope for column widths, but found while tracing writers:
   `scripts/sourcing_run/import_to_db.py:34` hardcodes a live production Postgres
   password in the repo.

## Not decided here

Per the role's rules, no fix is proposed or applied. Each column's `decision`
field states what a test should enforce (widen the column vs. truncate the
value vs. no action needed) and cites the writer that justifies it; the
`open_questions` array holds the cases where the right fix depends on a
judgment call this analysis can't make.
