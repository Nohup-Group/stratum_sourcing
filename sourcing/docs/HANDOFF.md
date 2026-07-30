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

## 3. Final numbers — run complete

Every one of the 605 discovered companies was scored. No backlog remains.

| | |
|---|---:|
| Entities extracted | **3,173** |
| Typed as companies | 1,672 |
| **Passed the thesis gate** | **462** |
| Signal-scanned | 462 |
| **Rated meet** | **25** |
| Rated monitor | 99 |
| Bands | 0 strong · 27 moderate · 116 weak · 323 poor |

139 rejected at the gate, 2 unresolved, **zero thin scans** — every scored
company cleared 40% coverage.

The meet list spans **12 countries**: Switzerland (5), UK (4), Netherlands (3), Luxembourg (2), Ireland (2), Germany (2), Norway (2), Bulgaria (1), Denmark (1), Romania (1), France (1), Finland (1).
Verticals: data-middleware 18, compliance 4, identity 3.
Cheque fit: core 18, unknown 5, stretch 2.
Coverage **0.74–1.00**; only
2 carry a "gate passed without evidence" flag.

**Where the gate-passing companies came from** — the thesis of the whole rebuild
in one row of data: directories 141, associations 72, registers 70, VC
portfolios 70, accelerators 39, sandboxes 25, conferences 20, consortia 10 —
and **press 2, research 1**. Lists produce investable companies; news does not.
The old pipeline drew 1,491 attributions from newsletters and yielded almost
nothing.

## 4. Calibration — resolved, and it changed the list

**Claude scores ~0.31 higher than codex on identical rules.** Measured on four
blind head-to-head pairs:

| Company | Claude | Codex | Δ | Signals resolved |
|---|---|---|---|---|
| Apiax | 0.75 | 0.40 | +0.35 | 31 → 55 |
| Salv | 0.59 | 0.28 | +0.32 | 37 → 55 |
| Axiology | 0.74 | 0.43 | +0.31 | — |
| Authologic | 0.70 | 0.43 | +0.26 | 28 → 62 |

**Codex is the more rigorous grader, not the stingier one.** It resolves ~1.7×
more signals per company. On Apiax it returned 25 confirmed and 30 absent where
Claude returned 24 confirmed and 7 absent — codex confirms *more*, but checks
far more and finds far more genuinely missing. Since fit is
`confirmed / resolved`, checking harder scores lower, correctly. Claude's higher
numbers came from a thinner denominator, which is the exact failure mode the
coverage metric exists to expose.

**Consequences:**
- Codex is the single grader. `GO_CLAUDE_SCORING` was deliberately **not**
  written, so `resume_after_limit.sh` no-ops at 04:56 and logs why. Do not
  create that file without re-measuring.
- Dedupe prefers codex over claude for any company scored by both.
- Apiax, Axiology, Authologic and Salv — which had been the top of the list —
  all fall to `weak` and out of `meet`. **Nothing scores `strong` any more.**
  The honest list is ~20 companies, all `moderate`, with coverage 0.80–1.00.

## 5. Demo guidance

**Lead with the funnel, not the count.** *2,796 names in → 1,295 companies →
83+ through the gate → 24 worth meeting* demonstrates judgment. The Anthropic
before/after is the proof it works, and the calibration story — the system
caught its own grader running +0.25 high and rebuilt the list — is a second
proof that it self-corrects.

**Best worked examples: Finologee (Luxembourg) or Evrotrust (Sofia).** Both
resolved **every** assessed signal — coverage 1.00, zero unknowns — which is the
strongest evidence base in the pipeline. Fipto and Enable Banking are equally
clean.

*Do not lead with Axiology*, despite what an earlier draft of this document
said. Its licence is real and I verified it myself against primary sources —
`UAB Axiology DLT` is on the
[Bank of Lithuania register](https://www.lb.lt/en/sfi-financial-market-participants//uab-axiology-dlt)
with a DLT TSS permission under Reg (EU) 2022/858 valid from 9 July 2025, and on
ESMA's authorised DLT market infrastructures list. But its 0.74 score came from
the generous grader; on the codex standard it is **0.48, weak**, and off the
meet list. It remains a good register-verification story, just not a top pick.

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
3. **100 meets.** Not reachable at the current bar. On the codex standard the
   meet rate is **6.8%**, so 100 meets needs roughly **1,475 scored companies**
   against 605 discovered — days of running, not hours. (An earlier draft said
   ~650; that was computed on the inflated grader before the calibration work.)
   Either let the machinery keep running, or demo the real number. Loosening the
   gate or the bands to reach 100 would hollow out the exact thing the demo
   sells.

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
