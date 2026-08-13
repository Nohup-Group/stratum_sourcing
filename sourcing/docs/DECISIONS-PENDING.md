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

- [ ] Commit and push to `main` — Railway redeploys `agent-jobs`, and
      `entrypoint.sh` applies migration 007 on boot
- [ ] Confirm the next two cron runs are green:
      `railway deployment list -p d77684e8-684b-4944-86f3-820b463c30a8 -s 5db361c0-ce97-4acb-9f7f-c0ade57f40c7 -e db5d50a5-7080-45a2-b1b8-7ec46c2270ed`
- [ ] Check for jobs stranded by the crash loop:
      `select id, job_type, status, attempts, last_error from agent_jobs where status in ('running','retry') order by updated_at desc limit 20`
- [ ] Decide whether a job dead-lettering at `attempts = 4` should alert
      anywhere — nothing watches `status = 'failed'` today, so the next poison
      pill will now fail quietly instead of loudly
