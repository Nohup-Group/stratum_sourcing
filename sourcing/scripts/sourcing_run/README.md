# Manual sourcing run — 2026-07-29/30

Tooling for the overnight discovery + scoring run that rebuilt the pipeline.
Kept in the repo because the scoring rules encoded here (`score_math.py`) are
the authority for how an agent-produced scan becomes a score, and because the
import/rollback pair is how anything reaches production.

| Script | Role |
|---|---|
| `score_math.py` | **The authority.** Recomputes fit, coverage and band from raw signal verdicts. Agent-reported numbers are never trusted — 18 of 52 audited companies reported a fit contradicting their own verdicts. |
| `merge_candidates.py` | Merges `disc_*.json` discovery output into one pool, deduped on registrable domain. |
| `build_shortlist.py` | Pool + scores → `shortlist.json` and `SHORTLIST.md`. Owns the derived verdict (meet/monitor/pass) and the engine-preference rule. |
| `import_to_db.py` | Additive import to production. Idempotent. |
| `rollback_import.py` | Reverses that import exactly, by provenance tag. |
| `triage.py` / `reclassify_entities.py` / `apply_reclassification.py` | Entity retyping: 1,884 → 1,274 companies. |
| `launch_scoring_codex.py` | Fans scoring out across `codex exec` sessions with in-flight claim tracking. |
| `refill_daemon.sh` / `sync_daemon.sh` | Keep sessions topped up; keep production in step. |

## Two rules worth not relearning

**Codex is the reference grader.** Measured across five blind head-to-head
pairs, Claude scores **+0.25 mean (median +0.26, all positive)** on identical
rules — because it resolves ~1.7× fewer signals, so its denominator is thinner.
Codex confirms *more* signals and finds *far more* genuinely absent. Mixing
engines makes rank depend on which one happened to pick a company up.

**Derived numbers are computed here, never read from the agent.** Agents
research; code does arithmetic.

Connection strings are read from the environment in anything that outlives this
run — the DSNs inlined here were for a one-off operator session.
