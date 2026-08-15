# Job/event lifecycle audit — byproduct summary

Full machine-readable contract: `docs/contracts/job-lifecycle.json`. This file
is a human-readable pointer into it, not a substitute for it.

## Scope

`app/services/job_queue.py` (agent_jobs + event_outbox), `run_agent_job_cycle`
in `app/services/agent_pipeline.py`, the Railway cron entrypoint
`app/tasks/agent_jobs.py` (`*/10 * * * *`, `TASK_MODE=agent-jobs`), and every
other writer of `agent_jobs`/`event_outbox` found by grep. 21 files read in
full or targeted-in-full; 8 files/groups explicitly not read, with reasons, in
the JSON's `coverage.not_read`.

A sibling contract, `docs/contracts/error-paths.json`, was found already
present (untracked) in this corpus during the investigation — a parallel audit
covering exception-handling shape across all 6 `TASK_MODE` entrypoints. Its
finding `B-01` independently derives the same `asyncio.CancelledError` gap
documented here as `C-02`, via the same citations. That is corroboration, not
duplication: this contract's scope is the `agent_jobs.status`/`event_outbox`
state machine specifically (dead-lettering, backoff, duplicate execution,
event dispatch), which `error-paths.json` does not cover.

## State machine

`pending → running → {completed | retry | failed}`, with `retry → running`
(reclaim) and a `running → running` self-loop for stale-lease reclaim
(`STALE_LEASE_MINUTES = 45`, `job_queue.py:136`). `completed` and `failed` are
confirmed true terminal states — exhaustive grep of every `.status =`
assignment to `AgentJob` across `app/` and `scripts/` finds exactly 3 writers:
`job_queue.py:164` (running), `job_queue.py:181` (retry/failed),
`agent_pipeline.py:752` (completed). Nothing ever reads a `completed` or
`failed` job back into another state.

The one live defect in this machine: under a specific, structurally-likely
condition (`C-02`), `running` becomes a practical absorbing loop — a job can
cycle `running → running` via stale-lease reclaim indefinitely without ever
being evaluated against the `attempts < 4` dead-letter decision, because that
decision only runs inside the `except Exception` branch a cancelled coroutine
never reaches.

## Findings (8: 2 critical, 2 high, 4 medium, 0 low)

- **C-01 (critical, lost_work)** — `dispatch_outbox_events` has none of the
  per-item isolation the class-C fix gave the job loop: no try/except per
  event, no per-event commit. One event whose handling raises aborts the
  *whole* cycle before any commit — discarding every event in the batch
  (reverted to `pending`, `attempts=0`) *and* blocking `claim_pending_jobs`
  entirely that cycle. Empirically reproduced: a synthetic malformed
  `entity_candidate` payload crashed the cycle and silently discarded a
  healthy `snapshot_ready` event's already-created job in the same batch (0
  `agent_jobs` rows survived). If the poison condition is deterministic, this
  repeats every cron tick forever with no circuit breaker (`event.attempts` is
  incremented but read nowhere — see C-04).
- **C-02 (critical, never_dead_letters)** — `asyncio.wait_for(..., timeout=900)`
  wraps the *whole* cycle (`app/tasks/agent_jobs.py:14`); a full-depth
  `signal_scan` job's worst case (8 batches × 480s) is 4x that budget.
  `CancelledError` is a `BaseException`, not `Exception`, since Python 3.8 —
  the per-job `except Exception` (`agent_pipeline.py:757`) does not catch it.
  A job cancelled mid-processing never reaches `mark_job_failed`; it sits
  `running` until the 45-minute stale-lease reclaim, and can repeat forever if
  the timeout condition is structural rather than incidental. Independently
  corroborated by `docs/contracts/error-paths.json` finding `B-01`.
- **C-03 (high, duplicate_work, inferred)** — the stale-lease reclaim is
  purely time-based, with no fencing/ownership check before a job is written
  `completed` or `retry`/`failed`. If a worker outlives 45 minutes while still
  genuinely alive (requires a non-cooperative hang the 900s watchdog can't
  reach), a second worker can reprocess the same job concurrently; whichever
  commits last wins silently. Mechanism is traced; the triggering scenario is
  inferred, not observed.
- **C-04 (medium, stuck_state)** — `event_outbox` has no stale-lease reclaim
  analogous to `agent_jobs`' 45-minute window, and `EventOutbox.attempts` is
  incremented but never read anywhere in the corpus — no backoff, no
  dead-letter concept for events at all. Currently latent (see C-01: nothing
  durably persists at `status='processing'` today), but structural.
- **C-05 (medium, backoff_wrong)** — `attempts` increments on every claim,
  including stale-lease reclaims unrelated to the job's own logic (infra
  churn, or C-02's cancellation loop). A job that loses its lease 4 times for
  unrelated reasons dead-letters on its very first *real* exception, having
  used its whole retry budget on lease loss instead of logic failure.
- **C-06 (high, silent_failure)** — nothing in the corpus reads
  `AgentJob.status == 'failed'`. No API, console, Slack, or Notion surface.
  Already tracked as an explicit open item in this repo:
  `docs/DECISIONS-PENDING.md:59-61`.
- **C-07 (medium, silent_failure)** — `watchlist_update_ready` is the only
  event type `dispatch_outbox_events` handles that creates *no* agent job; it
  is enqueued unconditionally on every entity-scorer run and every completed
  signal scan, with no consumer anywhere. This is the traced-and-reproduced
  explanation for the observed `dispatched_events=25 processed_jobs=0`
  production pattern — see `answers` in the JSON.
- **C-08 (medium, silent_failure)** — `scripts/sourcing_run/merge_duplicate_entities.py`
  deletes `agent_jobs`/`event_outbox` rows by raw SQL, outside the ORM. If it
  races a live cron cycle holding a lease on the same entity's job,
  `mark_job_failed` dereferences a `None` job with no guard, crashing the
  cycle the same way C-01/C-02 do.

## Question 6 — answered

Jobs created within a cycle **are** claimable and normally processed in the
**same** cycle: `dispatch_outbox_events` and `claim_pending_jobs` share one
uncommitted transaction with no commit between them
(`agent_pipeline.py:724-731`), so Postgres sees the transaction's own
uncommitted inserts, and `available_at` defaults to "now" at insert time.
Verified empirically against the scratch DB (`stratum_sourcing_test`):

| case | event type | result |
|---|---|---|
| A | `snapshot_ready` (job-creating) | `{dispatched_events: 1, processed_jobs: 1, failed_jobs: 0}` |
| B | `watchlist_update_ready` (terminal) | `{dispatched_events: 1, processed_jobs: 0, failed_jobs: 0}` |

Case B reproduces the exact shape of the production anomaly from a single,
well-formed, non-error event — no crash, no bug in claiming, just a dead-end
event type consuming dispatch budget. Whether the *specific* 2026-08-13 05:00
cycle was literally this is unconfirmed (no production `event_outbox` row
data available); what would confirm it: a query grouping that time window's
dispatched events by `event_type`.

## Verification performed

- Ran the existing gate: `TEST_DATABASE_URL=postgresql+asyncpg://erickpg@localhost:5432/stratum_sourcing_test .venv/bin/python -m pytest tests/test_agent_job_cycle.py -v` — both tests pass (baseline confirmed, not modified).
- Two throwaway probe scripts (outside the repo, in the scratchpad) against the
  same scratch DB: one settling question 6 (table above), one reproducing
  C-01's crash-and-discard behavior with a synthetic malformed payload. Not
  committed anywhere in the repo.

## Coverage

21 files read in full or in the relevant targeted section; 8 files/groups
explicitly skipped with reasons (see JSON `coverage.not_read`) — mainly the
source-ingestion pipeline, fetchers, and Notion integration, none of which
write `agent_jobs`/`event_outbox` per grep. 5 distinct write mechanisms found
for `agent_jobs` across 8 call sites; 3 for `event_outbox` across 6 call
sites — all enumerated in `coverage`.

## Open questions

See JSON `open_questions` for full detail + evidence:

- `Q-01`: is `watchlist_update_ready` a missing consumer, or an intentional
  terminal marker?
- `Q-02`: should `dispatch_outbox_events` get the per-item isolation the job
  loop already has (the direct sibling of the original motivating bug)?
- `Q-03`: should the 900s timeout be per-job instead of per-cycle?
