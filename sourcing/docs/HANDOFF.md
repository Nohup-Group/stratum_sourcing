# Overnight handoff — Stratum³ sourcing

Work carried out 2026-07-29 evening through 2026-07-30 early morning.
Everything below is live in production unless explicitly marked otherwise.

---

## 1. What was wrong

The console ranked **Anthropic #1 of 1,825 companies at 0.945**, ahead of every
real investment target. Four measured defects:

| Defect | Evidence |
|---|---|
| Score measured press, not fit | Score correlated with log(mention count) at **r = 0.762** |
| Entity table was 87% not-companies | Regulators, VCs, media, tokens, laws, countries, AI models all typed `company` |
| Unknown signals earned half credit | Securitize was the #1 weekly pick at 50.8% "moderate" off **3 confirmed, 58 unknown** |
| No eligibility gate | Nothing filtered for European / early-stage / institutional / infrastructure |

The ranking was not noisy, it was **inverted**: the companies the fund can
invest in scored 0.26–0.62; the ones it can never invest in scored 0.78–0.95.

## 2. What is now live

**Code — 10 commits merged to `main`, deployed.**
- Scoring: unknown and not-applicable excluded from the denominator; coverage
  reported separately; category-weighted fit with Founder & Team at 0.30;
  banding gated on coverage ≥ 0.40. **15 unit tests.**
- Entities: 14 types instead of 2, domain-based identity, lifecycle status,
  and the 7-gate thesis check as first-class fields. Migration 006.
- Console: ranks eligible companies first, excludes gate-failed and
  acquired/dissolved from picks, renames `heuristic_score` → `triage_score`.
- New **Sourcing map** page and a per-company **radar chart**.

**Database.**

| | Before | After |
|---|---|---|
| Rows typed `company` | 1,884 | **1,274** |
| Retyped correctly | — | **610** |
| Marked ineligible | 0 | **981** |
| Gate-passed with full scans | 0 | see §3 |
| Discovery sources registered | 131 | **414** |

## 3. Current numbers

See `shortlist.json` / `SHORTLIST.md` for the live figures — they move every
few minutes while the run continues. At time of writing: pool ~605 candidates,
~254 shortlisted, **~23 rated meet**.

Funnel on the console: **2,796 entities → 1,295 companies → 83 through the gate
→ 16–25 strong or moderate.**

## 4. The open calibration question — read this before demoing

**Codex and Claude do not score the same company the same way.** On the first
head-to-head, Axiology scored **0.74 (strong) on Claude and 0.43 (weak) on
codex** under an identical contract and identical arithmetic. The gap is
verdict generosity: how readily each engine calls a signal confirmed.

Codex scored 225 of 232 shortlisted companies, so codex is the reference
population and dedupe now prefers it. A blind codex re-score of the seven
claude-scored companies — which include the demo's then top three, Apiax,
Authologic and Salv — was running when this was written. Check
`scored_recheck.json` and compare before trusting the top of the list.

Claude bulk scoring at the 04:56 quota reset is **gated**: `resume_after_limit.sh`
no-ops unless a file named `GO_CLAUDE_SCORING` exists. Write that file only if
the measured bias is small.

## 5. Demo guidance

**Lead with the funnel, not the count.** *2,796 names in → 1,295 companies →
83 through the gate → ~20 worth meeting* demonstrates judgment. The Anthropic
before/after is the proof it works.

**Best worked example: Axiology** (Vilnius). I verified its licence myself
against primary sources, not company copy: `UAB Axiology DLT` appears on the
[Bank of Lithuania register](https://www.lb.lt/en/sfi-financial-market-participants//uab-axiology-dlt)
with a DLT TSS permission under Reg (EU) 2022/858 valid from **9 July 2025**,
and on ESMA's authorised DLT market infrastructures list. Its radar shows full
marks on regulatory and investor signals and a visible gap on commercial
traction — which matches the write-up. That honesty is the selling point.

**Be careful with 360X AG** (currently top at 0.89). It is genuinely on-thesis,
but its capital gate passed on *"no amount disclosed, therefore below the
ceiling"* — and it is backed by Deutsche Börse and Commerzbank. It carries a
"gate passed without evidence" flag. 18 shortlisted companies share that flag.

**Where companies come from** — registers, sandbox cohorts and member
directories decisively outperform news. Newsletters supplied 1,491 of the old
pipeline's attributions and produced almost nothing investable, because by the
time a European infrastructure company appears in a newsletter it has usually
already raised past the ceiling.

## 6. Open decisions for you

1. **The €30m ceiling.** Raised from €20m on your call. Dfns (~€27–28m), Spiko
   (~€23m), Gradient Labs (~€25m) and Tatum re-qualified. Notabene did not — it
   also fails on stage (Series B) and geography (Brooklyn entity).
2. **Claude vs codex as grader** — see §4.
3. **100 meets.** Not reachable at the current bar. Meet rate is **13.4% for
   high-confidence candidates and 5.9% for medium**, and the high-confidence
   ones were scored first. 100 meets needs ~650 scored companies. Either let
   the machinery run through tomorrow, or demo the real number.

## 7. Operating the machinery

All in `scratchpad/`, all running detached:

| Script | Role |
|---|---|
| `refill_daemon.sh` | Holds ~24 codex scoring sessions topped up; backs off above load 30 |
| `sync_daemon.sh` | Re-imports to production every 10 minutes (idempotent) |
| `resume_after_limit.sh` | Gated claude resume at 04:56 |
| `merge_candidates.py` | Merges all `disc_*.json` into `candidate_pool.json`, deduped on domain |
| `build_shortlist.py` | Recomputes fit/coverage/band from raw verdicts → `shortlist.json`, `SHORTLIST.md` |
| `import_to_db.py --commit` | Additive import; `rollback_import.py --commit` reverses it exactly |
| `apply_reclassification.py` | Entity retyping (already applied) |

**Known operational gap: the `sourcing-console` service does not auto-deploy.**
Its last GitHub-triggered deploy was 28 July. I have been deploying it manually
via `railway up` from an isolated copy of the directory (`railway up` from the
repo root fails — Railpack finds no app). Reconnect the GitHub trigger or
frontend changes will silently not ship.

## 8. Things worth knowing about how the agents behaved

- **Agent arithmetic cannot be trusted.** 18 of 52 audited companies reported a
  fit that contradicted their own signal verdicts, almost always understated.
  One reported 0.0/0.0 against a real 0.642/0.96 and would have been dropped
  silently. All derived numbers are now computed in `score_math.py` from the
  raw verdicts — agents research, code does maths.
- **Gates were passed on absence of evidence** until the contract forbade it.
- **Name collisions are the most common capture error** — five confirmed
  wrong-company captures across 24 companies in one early slice.
- **Sessions die often.** Roughly a third hit API stalls, watchdogs or quota
  limits. Agents now write output incrementally so a death costs one company
  rather than a whole slice.
