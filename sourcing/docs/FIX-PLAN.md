# Fix plan — the 2026-08-14 audit

Findings and evidence: `docs/contracts/*.json`. This file is the execution
order and the gate for each node. A node is done when its gate passes, run by
something other than the change itself.

## The constraint that sets the order

Every schema change re-opens the migration rollover window that crashed
notion-control-plane on 2026-08-13: the first container to boot applies the
migration, and every service still on the old image then fails
`alembic upgrade head` until it rolls over. So:

- code-only fixes ship first — no migration, no rollover window;
- **all width fixes go in ONE migration**, not one per column, so there is one
  window instead of five;
- the deploy hazard itself (N1 below is not it — see N5) needs a decision
  before it can be built.

## Nodes

### N1 — Outbox per-event isolation (C-01, C-04) · code only

The unfixed twin of the crash we already shipped. `dispatch_outbox_events`
(`app/services/job_queue.py:192`) has no try/except and no per-event commit, so
one bad event aborts the cycle and discards every co-batched event.
`EventOutbox.attempts` is incremented at `claim_pending_events` but read
nowhere, so there is no dead-letter path.

- **Change:** mirror the job loop — per-event try/except, `await db.rollback()`
  before touching the session, per-event commit, and dead-letter on
  `attempts >= 4`.
- **Gate:** a test that seeds one poisoned and one healthy event in the same
  batch, asserts the cycle does *not* raise, the healthy event's job is created
  and processed, and the poisoned event lands in a terminal state with its
  attempt count advanced. Must fail on the pre-fix code.
- **Verifier:** `verifier` subagent, asked to refute, before merge.
- **Blast radius if wrong:** the outbox stops dispatching. Caught by the gate.
- **Status 2026-08-14: implemented, gate green (23 tests), one verifier round
  survived, second round pending.** `tests/test_outbox_dispatch.py`, 6 tests
  (23 in the suite).
  Committing the event claim made stale `processing` rows reachable, so
  `claim_pending_events` gained the 45-minute reclaim `claim_pending_jobs`
  already had.

  Two blocking defects the verifier found, both fixed:
  1. The lease first rode on `EventOutbox.updated_at`, written by
     `onupdate=datetime.utcnow` — a naive value on a `timezone=True` column, so
     it lands offset by the process UTC offset and the lease expires instantly
     anywhere but UTC. Measured: 2h drift on `Europe/Berlin`, 9h on
     `Asia/Tokyo`, 4h into the future on `America/New_York`. Two dispatchers
     then process the same event. The lease now rides on `available_at`, always
     written explicitly with an aware datetime. The suite runs green under all
     four timezones.
  2. The reclaim test wrote `updated_at` by hand and never asserted the
     negative, so a zero-length lease read as working. There is now a test that
     a freshly claimed event is *not* stealable, and the stranded case takes its
     lease through the real claim path.

  Mutation-verified, each mutant caught by exactly one test: no try/except,
  no rollback, no claim commit, no stale clause, `retry=True`, lease back on
  `updated_at` (caught only under a non-UTC TZ), status always `dispatched`,
  watchlist returning 0. Note the first poison chosen (a non-dict payload)
  raises *before* any DB write and so never exercises the rollback — a separate
  test injects a real DB error for that.

  Also closed here: `db.get` after a committed claim could return `None` if the
  row is deleted concurrently (`scripts/sourcing_run/merge_duplicate_entities.py:37`
  deletes outbox rows), which would have raised out of the cycle — the exact
  shape this node removes. Guarded in both the event loop and the job loop.

  Known wrinkle, not fixed: `available_at` now carries two meanings — "not
  before this time" while `pending`, "lease expires at" while `processing`.
  Both reads live in `claim_pending_events` and agree, but it is one column
  doing two jobs. Related: a reclaimed event whose job was already created hits
  `on_conflict_do_nothing` in `enqueue_agent_job` (unique on `job_type,
  external_ref = "event:<id>"`), so `created_job` is None and the event is
  marked `ignored` rather than `dispatched`, counting 0. Harmless — the job
  exists — but the status reads as though nothing happened.

  **Verifier round 2** confirmed the `available_at` dual meaning is cleanly
  separated by `status` (exhaustive matrix: no lease value ever appears on a
  pending row, no backoff value on a processing row), the timezone dependency
  is gone (measured under four TZs), and the 45-minute boundary is exact
  (44.90m → not claimable, 45.08m → claimable). It found one more real defect:

  3. `attempts` was incremented on every *claim*, including a reclaim, so an
     event stranded by a dispatcher death spent retry budget no handler had
     used. Proven: three strandings then one transient error dead-lettered an
     event that had never actually been tried. Terminal, too — every producer
     passes a stable `dedup_key` and `enqueue_event` does
     `on_conflict_do_nothing`, so a `failed` event can never be recreated.
     Three strandings 45 minutes apart is exactly what the 2026-08-12 crash
     loop did. Fixed: a claim no longer counts, `mark_event_failed` is the one
     place a delivery attempt is recorded, and
     `test_being_stranded_does_not_spend_the_retry_budget` locks it in —
     restoring the claim-time increment fails 4 tests.

  One round-2 claim did **not** hold up: it reported that deleting the lease
  write and the reclaim clause together leaves the suite green. Measured
  directly — that combination fails the stranded test (`1 failed, 22 passed`).
  Its narrower point stands: `test_a_freshly_claimed_event_is_protected_by_its_lease`
  passes on pre-fix code, because pre-fix the claim only ever selected
  `pending`. It is a regression guard against the `updated_at` lease rather
  than a reproduction of the original bug, and it is the only test that catches
  that mutation, so it stays.

  Residual, accepted: after >45 minutes of single-batch overlap, dispatcher 1's
  terminal write can clobber a lease dispatcher 2 took on reclaim — last write
  wins on a row neither holds a lock on. Unreachable while the cron budget is
  900s.

### N1c — A claim counts as an attempt on the job side too · latent

`claim_pending_jobs` (`app/services/job_queue.py`) does `job.attempts += 1`,
and the stale-lease reclaim path goes through the same code, so a job stranded
by a worker death burns retry budget exactly as events did before N1. This is
pre-existing and was left alone rather than bundled into N1, because yesterday's
shipped behaviour depends on the current counting and changing it needs its own
gate. Note it is not hypothetical: the 2026-08-12 crash loop drove a real job to
`attempt=3` this way.

- **Gate:** the job-side mirror of
  `test_being_stranded_does_not_spend_the_retry_budget`.

### N1b — Naive `datetime.utcnow` on eight timezone-aware columns · latent

`onupdate=datetime.utcnow` appears 8 times in `app/models.py` (lines 141, 304,
329, 386, 465, 520, 570, 676) on `DateTime(timezone=True)` columns. Every one
writes a value offset by the process's UTC offset. Nothing reads these for
logic today except `notion_control.py:478`, which only orders by them — and N1
deliberately stopped depending on one. Production containers are UTC so the
values are currently correct by accident.

- **Gate:** a test asserting that after an ORM update, `updated_at` is within a
  second of the database's `now()`, run under a non-UTC `TZ`.
- **Not urgent, but it is a loaded gun:** the next person to write a
  time-window query against `updated_at` gets the same bug I just did.

### N2 — Timeout escapes the recovery path (B-01 / C-02) · code only

`asyncio.wait_for(..., timeout=900)` at `app/tasks/agent_jobs.py:14` with no
handler; `except Exception` has not caught `CancelledError` since Python 3.8,
so an overrunning cycle exits non-zero like a crash.

- **Change:** decide and implement — catch `BaseException` around the per-job
  body to release the lease, and/or handle `TimeoutError` at the task
  entrypoint so an overrun exits 0 with a logged partial result.
- **Gate:** a test that forces a cycle to exceed its budget and asserts the
  process-level result is a clean partial completion, not an exception, and
  that in-flight jobs are left in a reclaimable state.
- **Note:** latent — zero occurrences in captured production logs. Longest
  observed gap between cycle starts is 1224s against a 600s period.

### N3 — Credential rotation (from `column-widths.json` open_questions) · needs Erick

`scripts/sourcing_run/import_to_db.py:34` + 3 siblings hardcode a live DSN for
the public Railway proxy. Committed, in git history — rotation is the only fix.

- **Done 2026-08-14: five scripts, not four.** The pre-push verifier found
  `scripts/sourcing_run/reclassify_entities.py` still hardcoding the same live
  DSN — split across two adjacent string literals, so the `@host` never
  appeared on the same line and the grep gate reported the repo clean while
  `--apply` still wrote to production. It also found that
  `docs/contracts/column-widths.json`, added by this same change, carried the
  password verbatim: committing the audit would have added a *new* copy of the
  secret. Redacted.
- **The gate is gitleaks, after four rounds proved a hand-rolled one does not
  work.** `tests/test_secret_scanning.py` + `.gitleaks.toml`. The hand-rolled
  scanner was rewritten four times and was wrong in a new way each time:
  it scanned only tracked files (blind to every new file in a change — the
  verifier put the real password into an untracked `docs/contracts/` file and
  it stayed green); it scanned `sourcing/` while the git root is one level up,
  covering 106 of 252 committable files; the `\b` added in round 3 blinded it
  to every `*_PASSWORD` name including `CONSOLE_PASSWORD`, which this repo
  uses; and it missed `"password": "…"`, the JSON form used by the very files
  it was added to protect. Each fix created the next hole. Detecting secrets by
  shape is a maintained-ruleset problem.

  **gitleaks' defaults were not enough on their own** — verified, not assumed:
  `CONSOLE_PASSWORD=<32 chars>`, `password="<32 chars>"` and
  `"password": "<32 chars>"` all produce **zero** findings under the default
  rules. Two custom rules cover them, both entropy-gated so
  `password = resolveControlUiPassword()` is not a finding. A third handles a
  DSN split across two string literals, which is line-invisible to any
  line-based scanner and is exactly how the fifth script's credential hid.

  Verified case by case — caught: single-line DSN, split literal,
  `CONSOLE_PASSWORD=`, psycopg kwargs, JSON `"password":`, `%`-encoded secret.
  Allowed: function calls, local-dev URLs, password-less URLs, `<REDACTED>`,
  f-string templates. Both earlier blockers reproduce as failures end to end.

  Deliberate: it scans the **committable** file set — `git ls-files --cached
  --others --exclude-standard`, copied to a temp tree — not the filesystem.
  `gitleaks dir` ignores .gitignore, and a local `.env` holding the production
  DSN is the documented way to run the sourcing_run scripts; flagging it would
  make the gate red for a legitimate setup, and a gate that is red for a
  legitimate setup gets deleted. It scans the working tree, not git history —
  the password is still in history and rotation was declined, so scanning
  history would be permanently red and therefore permanently ignored. And it
  does not skip when gitleaks is absent; it fails with an install hint.

  **Round 5 found the worst defect of the whole exercise, and it was in this
  gate's own test.** The fixture read
  `secret = "tiUIjkiv" + "XjqdtVCT" + "taaQyAwX" + "IchMujFt"` — four literals
  concatenating to the *live production password*, sitting in the one path the
  config permanently allowlisted. The diff would have taken HEAD from five
  files containing the credential to one file containing it in an exempt path,
  with the suite green and gitleaks reporting nothing. The docstring claimed
  the opposite. It was the same split-literal trick this config's own comment
  says hid a credential for months. The fixture now derives a synthetic secret
  at runtime, so no credential-shaped literal exists in the file and it needs
  **no exemption at all** — the exempt path is gone rather than made safer.

  Round 5 also proved the entropy thresholds were meaningless. gitleaks measures
  Shannon bits per *character*, ceiling log2(len), so `entropy = 4.0` could
  never fire below 16 characters; 36 of 132 realistic secret/shape combinations
  went undetected. Measured, the distributions overlap outright —
  `getPasswordFromVault` (3.822) scores exactly as high as
  `Tr0ub4dor&3Xkcd!2024`. Discrimination is now structural and entropy is only
  a floor: caught across all assignment shapes are `Tr0ub4dor&3Xkcd!2024`,
  `Sommer2024Berlin`, `8471926350284617`, `hunter2hunter2`, `postgres_Yx91Kd`;
  allowed are `resolveControlUiPassword`, `getPasswordFromVault`,
  `process.env.DB_PASSWORD`, `DB_PASSWORD`, `YOUR_PASSWORD_HERE`,
  `password_placeholder`, `os.environ` — zero false positives.
  **Known gap:** an all-lowercase passphrase (`correcthorsebatterystaple`) in a
  `password=` assignment is not caught, because it is structurally identical to
  an identifier. Caught in every DSN shape, missed in bare assignments.

  Third round-5 defect: the rule allowlist used `regexTarget = "match"`, which
  made each pattern re-anchor on `password<sep>` and therefore inspect only the
  first characters of the value — so any secret merely *beginning* with `$`,
  `{`, `secret`, `postgres` or `<REDACTED>` was exempt in full. The allowlists
  now apply to the captured secret and are anchored.
- **Invocation:** `DATABASE_URL=… python3 scripts/sourcing_run/<script>.py`, or
  `SOURCING_DSN` to target a different database. The lookup is lazy, so
  `--help` works without either. `DATABASE_URL` is the app's
  `postgresql+asyncpg://` URL, which psycopg cannot parse — the scripts strip
  the driver marker, which the first version of this change did not, so the
  documented invocation would have failed outright.
- **Erick decided not to rotate.** Recorded so it is a decision and not an
  oversight: the secret remains in git history across at least 4 commits and
  is recoverable with `git log -p` by anyone with repo access, and it points at
  the public Railway TCP proxy (`switchback.proxy.rlwy.net:16120`) rather than
  the internal network. Removing it from the tree stops new exposure, not
  existing exposure. Revisit if repo access ever widens.

### N4 — Width fixes, batched into one migration (class A) · one rollover window

11 columns need a decision in `column-widths.json`: 1 `must_widen`,
10 `must_truncate`. Highest: `signal_results.result` is `String(12)` while the
code's own `UNSCORED_RESULTS` contains `not_applicable` (14 chars) —
`app/models.py:639` vs `app/services/signal_engine.py:176`.

- **Change:** one alembic revision covering every widen; truncation at the
  write site for the `must_truncate` columns.
- **Gate:** a test that reads `column-widths.json` and fails when a `String(n)`
  column exists in `Base.metadata` that the manifest does not classify, or when
  a column's live type contradicts its `decision`. This is the part that closes
  the *category* rather than the instance.
- **Open first:** confirm whether `not_applicable` currently reaches the insert
  at `signal_engine.py:471`, or is filtered upstream. Not yet observed firing.

### N5 — Migrations on boot, 9 services, one database (D-01, D-02, D-04) · needs a decision

Root cause of three findings including the deploy-side critical.
`entrypoint.sh:10` and `:47` both run `alembic upgrade head` unconditionally,
with no locking.

**Decided 2026-08-14: tolerate-ahead + advisory lock.** Done, in
`alembic/env.py` rather than `entrypoint.sh`, so both call sites (line 10 and
line 47) are covered by one change and the "which failure is forgivable"
decision stays precise instead of becoming a blanket `|| true`.

- A session-scoped `pg_advisory_lock` wraps the migration. Session-scoped, so
  it survives the migration's own commits and is released automatically if the
  process dies — a crashed migrator cannot wedge the other eight.
- If `alembic_version` names a revision this image does not contain, that is a
  newer peer having already migrated, not this container's error: log and skip,
  exit 0. **Every other failure stays fatal.**
- **Gate:** `tests/test_migration_boot.py`, 6 tests. Mutation-verified:
  `if True` in place of the ahead-check fails the broken-migration test;
  removing the lock fails the serialisation test; sharing one connection fails
  both fresh-database tests.

  **The first version of this shipped-nothing but nearly did, and the pre-push
  verifier caught it.** Running the lock and the revision check on the same
  connection alembic then migrates on left an open transaction, so
  `MigrationContext` saw `_in_external_transaction`, `begin_transaction()`
  degraded to a `nullcontext`, and `self._transaction` stayed `None`. Two
  consequences: migration 006's `autocommit_block()` raised `AssertionError`, so
  **any database behind 006 could no longer migrate at all** and stopped at 005;
  and migrations lost atomicity — a migration failing partway committed its DDL
  without advancing the revision, which would fail every subsequent boot of all
  nine services on a duplicate column. The lock and check now use a dedicated
  connection and the migration gets a pristine one.

  Why four migration tests missed it: they all ran against the scratch database,
  which was already at 007, where `upgrade head` has nothing to do. A migration
  guard was being tested against a database with no migrations left to run.
  `test_an_empty_database_migrates_all_the_way_up` and
  `test_a_migration_that_fails_partway_leaves_nothing_behind` now create and
  drop a genuinely empty database.

  **Correction from round 3: `guard.rollback()` is load-bearing, not defensive.**
  I recorded it as covering an unreachable case. It is what releases the
  advisory lock when the *revision check itself* raises — the verifier removed
  that one line, forced the check to fail, and watched the lock leak while the
  process was still alive, with the suite still at 31 passed. The masking is
  unreachable; the lock release is not, and it is untested. Accepted rather
  than fixed: each `alembic upgrade head` is its own process, so the leaked
  lock drops with the connection microseconds later. The mutation gap is real
  and recorded.
- **Sequencing:** this had to land BEFORE N4. It only helps containers running
  the new code, so the first migration after it deploys is the first graceful
  one. Shipping N4 first would have crashed all nine services one more time.
- Still required, and not enforceable by a test: migrations must stay
  backward-compatible with the previous image, since old containers now keep
  running against a schema that has moved ahead. 007 qualified — widening a
  column is safe for code that does not know about it.

### N6 — Nothing watches failed jobs (C-06) · deferred, needs a decision

No code anywhere reads `AgentJob.status == 'failed'`. After N1 both a poisoned
job and a poisoned event dead-letter silently. Decide where that should surface
(Slack notifier already exists) before building it.
