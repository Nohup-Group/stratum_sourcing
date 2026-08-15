# Pending

## agent-jobs crash loop — fixed locally, not shipped (2026-08-12)

`agent-jobs` (Railway project Stratum3, cron `*/10 * * * *`) crashed on nearly
every run between 04:30 and 07:30 CEST on 2026-08-12. Job 177227
(`entity_extractor`, finding 4116, source 37) wrote a 101-character `role_hint`
into `entity_mentions.role_hint VARCHAR(80)`; the handler in
`run_agent_job_cycle` then died on its own logging call because it never rolled
the session back, so the exception left the cycle and the container exited
non-zero. `mark_job_failed` never ran, `attempts` stayed at 3, and the next
cron run claimed the same job again.

Fixed on `main`, uncommitted:

- `alembic/versions/007_widen_role_hint.py` — `role_hint` → `TEXT`
- `app/models.py` — same, in `EntityMention`
- `app/services/agent_pipeline.py` — commit the claim before running jobs;
  roll back before touching the session in the failure path; reload the job
  each iteration
- `tests/test_agent_job_cycle.py` + `tests/conftest.py` — the gate

Gate:

```
createdb stratum_sourcing_test
TEST_DATABASE_URL=postgresql+asyncpg://localhost/stratum_sourcing_test \
    .venv/bin/python -m pytest
```

`test_a_failing_job_does_not_take_the_cycle_down` reproduces the production
traceback exactly on the pre-fix handler. `test_a_role_hint_longer_than_80_chars_persists`
gates migration 007 — its fixture runs `alembic upgrade head`, so it fails only
if the migration is missing, not if `app/models.py` alone regresses; the model
is asserted directly instead.

Two things the verifier turned up that were accepted rather than fixed:

- **A dead connection at the per-job `await db.commit()` still exits the
  process** — it sits outside the try, and nothing can be recorded on a broken
  session anyway. What changed is the recovery: the batch is now stranded as
  `running` for `STALE_LEASE_MINUTES` (45) with an attempt burned, where before
  it reverted to `pending` within 10 minutes. That is the deliberate other side
  of making the claim durable — the accidental revert was also what let the
  poison pill retry forever.
- **Nothing runs this gate but a person.** There is no `.github/workflows` in
  the repo.

- [x] Pushed as `c55b509`, live as deployment `0429451b`. Boot log 2026-08-13
      21:00 UTC: `Running upgrade 006 -> 007`, then
      `agent_jobs_complete dispatched_events=0 failed_jobs=0 processed_jobs=0`.
- [x] No jobs were stranded by the crash loop — every run since 04:32 UTC
      claims 0 jobs, so nothing is sitting in `running` or `retry`.
- [x] Proven in production overnight 2026-08-13/14: 327 jobs started, 327
      done, 0 failed, no traceback and no container stop. 28 of them were
      `entity_extractor` jobs writing 178 mentions — the exact path that
      crashed on the 12th and 13th. Every job ran at `attempt=1`, so nothing
      was re-claimed after a failure.
- [ ] Decide whether a job dead-lettering at `attempts = 4` should alert
      anywhere — nothing watches `status = 'failed'` today, so the next poison
      pill will now fail quietly instead of loudly

## Audit of the same defect classes (2026-08-14)

Four contracts in `docs/contracts/`, machine-readable, one per class:
`column-widths.json` (37 string columns traced to their writers),
`error-paths.json`, `job-lifecycle.json`, `deploy-hazards.json`.
39 entries: 4 critical, 9 high, 13 medium, 2 low, plus 11 columns needing a
width decision. `B-01` and `C-02` are the same defect found independently by
two analyses; the pre-push verifier reproduced it a third time.

Ordered by what actually bites first:

- [ ] **Rotate the production Postgres password.** `scripts/sourcing_run/import_to_db.py:34`
      and three sibling scripts hardcode a live DSN pointing at the public
      Railway TCP proxy (`switchback.proxy.rlwy.net:16120`). It is committed
      and present in git history across at least 4 commits, so deleting the
      line does not remove it — rotation is the only fix. Not exploited as far
      as anything here shows; this is exposure, not a known breach.
- [x] **`dispatch_outbox_events`, the unfixed twin — FIXED 2026-08-14, not yet
      pushed.** Per-event try/except, rollback, per-event commit, committed
      claim, and a real dead-letter at 4 delivery attempts. `EventOutbox.attempts`
      is now read. Gate: `tests/test_outbox_dispatch.py`. Details in
      `docs/FIX-PLAN.md` N1.
- [ ] **The 900s timeout escapes the recovery path** (`app/tasks/agent_jobs.py:14`,
      B-01/C-02). `except Exception` has not caught `CancelledError` since
      Python 3.8, so a cycle that overruns exits non-zero exactly like the
      crash we just fixed. Latent: zero occurrences in any captured production
      log, but the longest gap between cycle starts is already 1224s against a
      600s cron period.
- [ ] **`signal_results.result` is `String(12)` and the code's own vocabulary
      contains `not_applicable` (14 chars)** (`app/models.py:639` vs
      `app/services/signal_engine.py:176`). Not external input — a constant
      that cannot fit its own column. Not yet observed firing; confirm whether
      `not_applicable` currently reaches the insert at `signal_engine.py:471`.
- [x] **Migrations on boot — DECIDED and FIXED 2026-08-14, not yet pushed.**
      Chosen: tolerate-ahead + advisory lock, implemented in `alembic/env.py`.
      Gate: `tests/test_migration_boot.py`. Details in `docs/FIX-PLAN.md` N5.
- [ ] **The rule that decision now depends on: migrations must stay
      backward-compatible with the previous image.** Before, a stale container
      exited non-zero and never ran its task; now it logs, skips, and *runs*
      against a schema it does not know. That is the intended trade — a crash
      loop for a compatibility rule — but it is a rule with no test behind it.
      A migration that renames or drops a column will now be executed against
      by every not-yet-rolled-over service instead of stopping it. Widening,
      adding nullable columns and adding tables are all safe. Decide whether
      this is enforced by review, by a checklist in the migration template, or
      not at all.
- [ ] Answered, no longer a mystery: the `dispatched_events=25 processed_jobs=0`
      cycles are `watchlist_update_ready` events (`job_queue.py:244`) — a
      terminal event type with no consumer anywhere in the corpus, enqueued
      unconditionally on every scoring run. Reproduced: one such event yields
      exactly `{dispatched_events:1, processed_jobs:0}`.
