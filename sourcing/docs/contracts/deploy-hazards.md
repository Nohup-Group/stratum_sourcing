# Deploy hazards — stratum_sourcing / sourcing-console

Byproduct of `docs/contracts/deploy-hazards.json` (the machine-readable deliverable).
Read that file for citations; this is a human-readable index into it.

Corpus: `sourcing/` + `sourcing-console/`, both subdirectories of one monorepo
(`stratum_sourcing`), commit `c55b509`. 7/7 migrations classified. See the
contract's `coverage` block for exactly which files were read in full, read
partially, or not read, and why.

## The headline finding (D-01)

Every one of the 9 Railway resources that build from this repo — not just on
deploy, but on **every boot**, including every cron tick — unconditionally runs
`python -m alembic upgrade head` (`entrypoint.sh:10` for TASK_MODE resources,
`entrypoint.sh:47` for the web service). There is no locking, no leader
election, and no separate migration phase anywhere in this repo. A push that
includes a migration lets the first container to boot on the new image advance
`alembic_version`; any other resource still booting the old image — because a
"near-simultaneous" 9-resource rollout is not atomic — crashes with `Can't
locate revision identified by '<new>'` the moment it next boots, whether that's
its own delayed redeploy, a crash-restart, or (for `agent-jobs`, every 10
minutes, and `notion-control-plane`, every 15 minutes) simply its schedule
firing mid-rollout. This is not specific to migration 007 — the same mechanism
fires on **every single migration**, regardless of what that migration
contains. `alembic/versions/003_placeholder.py` is direct evidence this exact
class of problem (DB revision state outrunning what a codebase snapshot can
resolve) has already happened once before, for a different proximate reason.

Three fix options are laid out with trade-offs in the contract's `open_questions`
(OQ-1) and D-01's `gate` field — none is picked here, per this task's
observe-don't-recommend framing for the decision itself; only the trade-offs
are stated.

## Migration classification (7/7)

| Rev | Kind | Destructive | Notable lock behavior |
|---|---|---|---|
| 001 | additive | no | new tables only, no contention possible |
| 002 | widening | no | brief ACCESS EXCLUSIVE, metadata-only widen |
| 003 | no-op | no | none — `pass` |
| 004 | additive | no | 3 non-CONCURRENT indexes, but on a ~131-414-row table |
| 005 | additive | no | new tables only, indexes on empty tables |
| 006 | **data-migrating** | no | non-CONCURRENT indexes on a populated `entities` table (thousands of rows) + a DML UPDATE, all inside one transaction — see D-03/D-04 |
| 007 | widening | no | brief ACCESS EXCLUSIVE, metadata-only widen — the migration named in the motivating incident |

**None of the 7 migrations are destructive** in the classic sense (no
`DROP COLUMN`, no `DROP TABLE`, no narrowing, no `NOT NULL` added without a
default). Every migration in this repo's history so far has been additive or
widening at the schema-shape level. The risk in this repo is not "a migration
will silently destroy data" — it is the boot-time coupling described in D-01.

`backward_compatible_with_previous_image` is `false` for every migration
002-007 in the contract, but note **why**: not because any of them would break
old application code reading the new schema (they wouldn't — see the table
above), but because of D-01's operational mechanism, which fires regardless of
migration content.

## Findings by severity

- **critical (1):** D-01 — the migration rollover window itself.
- **high (3):** D-02 (no locking around concurrent `alembic upgrade head`),
  D-05 (`CADENCE_BUCKET` silent-default scope creep), D-09 (sourcing-console's
  auto-deploy gap — structural risk, though today's check found zero live
  breaks).
- **medium (5):** D-03 (non-CONCURRENT index on a populated table), D-04
  (whole-upgrade-run single transaction accumulates lock duration),
  D-06 (`.env.example` missing ~15 of ~38 config.py settings), D-07 (two
  Postgres instances in one Railway project, routing not verified), D-08
  (`SOURCING_API_URL` cross-service coupling).
- **low (2):** D-10 (stale, non-breaking TS `band` union type), D-11 (dead
  `notion-export` TASK_MODE branch).

## Q5 — sourcing-console staleness: what we actually found

Checked directly, not assumed: `git log` shows the backend's console-facing
surface (`app/api/console.py`, `routes.py`, `schemas.py`) has had **zero
commits** since `1a46668` (2026-07-30 12:27:45), the same commit that last
touched `sourcing-console/` and produced the `dist/` build actually shipped
(same timestamp). Every route and query param sourcing-console's frontend
calls was diffed against the current backend implementation — **no live
mismatch found**. The one literal drift found (`sourcing-console/src/types.ts`
declares `band` as a union missing `"poor"` and `"insufficient-evidence"`, and
including a value, `"insufficient"`, the backend never produces) does not
affect runtime behavior — every actual usage in the frontend is a string-keyed
lookup with a fallback, not the narrow TS type. This is documented as D-10,
severity low, specifically so it isn't mistaken for a break.

The structural risk (D-09) stands regardless of today's clean result: nothing
in this repo would catch a *future* backend change to the console API landing
while sourcing-console silently keeps serving stale code, because
sourcing-console still does not auto-deploy.

## What eliminates the most findings at once

Fixing the boot-time migration coupling described in D-01
(`sourcing/entrypoint.sh:10` and `:47`, and the single-transaction batching in
`sourcing/alembic/env.py:30-35`) is the single change that removes D-01, D-02,
and D-04 together — three of eleven findings, including the only `critical`
and one of three `high` findings — because all three trace to the same root
cause: every resource re-running an ungated, unlocked `alembic upgrade head`
on every boot.

## Open questions

Five, written to `docs/contracts/deploy-hazards.json`'s `open_questions` array
with options and evidence for each, not decided here:

1. **OQ-1** (most important): how to fix the migration-boot coupling — single
   migration job vs. advisory lock vs. graceful-crash handling. Each option's
   trade-offs are in the contract.
2. OQ-2: is `CADENCE_BUCKET` unset-means-scan-everything intentional or a gap?
3. OQ-3: which of the two Postgres instances does each resource actually use?
4. OQ-4: is `notion-export`'s TASK_MODE branch dead code or just outside one
   `railway status` snapshot?
5. OQ-5: given no live break was found today, is reconnecting sourcing-console's
   GitHub auto-deploy still the right fix, or should the manual `railway up`
   process be formalized instead?
