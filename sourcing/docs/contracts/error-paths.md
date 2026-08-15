# Error-paths audit — byproduct summary

Full machine-readable contract: `docs/contracts/error-paths.json`. This file is a
human-readable pointer into it, not a substitute for it.

## Motivating bug

`run_agent_job_cycle`'s per-job `except Exception as error:` handler
(`app/services/agent_pipeline.py:757`) is **confirmed fixed** at commit
`c55b509`: it rolls back before touching the session again, captures
`job_id`/`job_type` as plain values before the try, re-fetches the job after
rollback, and `mark_job_failed` runs on every failure path. The migration that
widened `entity_mentions.role_hint` to `Text` (`007_widen_role_hint.py`) is
also in place. Both tests in `tests/test_agent_job_cycle.py` pass against a
live scratch Postgres.

## What else has the same shape

Literal grep of every `except` block in `app/` (37 total) found only **2** whose
try-body actually touches the AsyncSession — the correct centralized handler in
`app/database.py:33` and the already-fixed handler above. So the exact
literal shape of the motivating bug (no rollback before an ORM read) does not
recur elsewhere in this corpus.

What *does* recur is the same underlying failure mode — a per-item or
per-batch failure that should be contained instead taking down more than it
should, or vanishing instead of paging anyone — via three different
mechanisms:

1. **Exception-type mismatch, not a session bug** (`B-01`, critical). A
   signal-scan job can run up to 8 sequential LLM batch calls
   (`signal_scan_batch_size=25`, 200-signal library, 480s timeout each) inside
   the one AsyncSession `run_agent_job_cycle` holds for its whole cycle, while
   `app/tasks/agent_jobs.py` wraps the entire cycle in
   `asyncio.wait_for(..., timeout=900)` with **no try/except anywhere in the
   file**. `asyncio.CancelledError` (raised by that timeout) is a
   `BaseException`, not an `Exception` — it skips the per-job handler
   entirely and crashes the process. This is the single finding most likely
   to page someone next, and it reproduces the *class* of the original bug
   (a handler that doesn't catch what can actually be thrown) rather than its
   literal mechanism.

2. **One transaction spans a whole batch of non-idempotent external writes**
   (`B-02`, `B-03`, high). The three Notion-sync loops
   (`sync_findings_to_ocean`, `sync_source_registry_to_notion`,
   `sync_watch_targets_to_notion`) each call `create_page`/`update_page` per
   item with a single commit after the whole loop. A failure partway through
   leaves already-created Notion pages real, but their `notion_page_id`
   uncommitted locally — the next run recreates them.

3. **Failures that vanish instead of paging anyone** (`B-04`–`B-07`, high/medium).
   Six `/tasks/*` HTTP endpoints fire the same task functions via a bare
   `asyncio.create_task(...)` with no reference kept and no exception
   handler — any failure becomes an unread "Task exception was never
   retrieved" stderr line, no crash, no alert, no signal to the caller who
   already got `{"status": "accepted"}`. Separately, three of the six
   TASK_MODE entrypoints catch `asyncio.TimeoutError` specifically and only
   log it (no re-raise), so a real timeout exits 0 and is indistinguishable
   from success.

`B-08`/`B-09` round out the picture: `cadence_scan.py` has no try/except at
all around the same call `nightly_scan.py` partially guards (inconsistent
timeout handling for identical work), and `orchestrator.py` holds one DB
session/transaction open across an LLM call and two embedding calls per
source scan (session-held-across-model-latency, point 5 of the brief).

## Coverage

- 37/37 except blocks in `app/` inspected; 2 touch the session (both correct).
- 6/6 TASK_MODE entrypoints read in full.
- 37 files read; not-read list (with reasons) is in the JSON's
  `coverage.not_read` — mainly migrations, pure schema/model files
  (grep-verified empty of relevant logic), and manually-invoked
  `scripts/*.py` that aren't wired into any TASK_MODE.

## Open questions (see JSON `open_questions` for full detail + evidence)

- `Q-01`: the given subclass taxonomy needs 1–2 more buckets for what was
  actually found here (exception-type mismatch with no DB involved;
  unretrieved fire-and-forget task exceptions; swallowed timeouts that report
  success).
- `Q-02`: the 6 task entrypoints implement 3 different, inconsistent policies
  for "what happens when the outer timeout fires" — this needs one decision,
  not six.
- `Q-03`: should the Notion sync loops commit per item, or make the writes
  idempotent, given Notion `create_page` isn't idempotent?
- `Q-04`: are the `/tasks/*` HTTP trigger endpoints a permanent parallel path
  to the Railway crons, and if so, how should their failures become visible?
