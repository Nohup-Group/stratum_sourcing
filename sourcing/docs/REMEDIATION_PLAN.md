# Sourcing console: clean it, and keep it clean

Measured on production, 2026-07-29. 1,825 rows in `entities` typed `company`,
891 typed `person`. Two signal scans completed. Nothing else has been scored
against the 200-signal library.

The console's ranking is not merely noisy — it is **inverted**. Score correlates
with log(mention count) at **r = 0.762**. The companies the fund can actually
invest in sit at 0.26–0.62; the companies it can never invest in sit at
0.78–0.95.

Fixes are ordered by dependency. Each one is worthless without the one above it.

---

## Layer 0 — Extraction: stop minting garbage entities

**Now:** the entity extractor creates a `company` row for every proper noun in
every article. Measured contamination across the 1,825 rows:

| Not a company | Count | Examples |
|---|---:|---|
| Generic nouns | 137 | `banks`, `crypto`, `vaults`, `fintechs`, `140 companies`, `New`, `Real` |
| Tickers / acronyms | 111 | `HYPE`, `WBTC`, `SPY`, `XAU₮`, `POL`, `$MEGA` |
| VCs & investors | 105 | a16z, Balderton, Seedcamp, Sequoia, Tritemius Fund I |
| Regulators & government | 98 | SEC, FCA, ECB, BaFin, Europol, FBI, Skatteverket |
| People | 78 | Trump, Musk, Judge Katherine Polk Failla, ~40 Swedish names |
| Media & events | 82 | Bankless, Breakit, WSJ, Money20/20, Paris Blockchain Week |
| Standards & laws | 29 | MiCA, GDPR, PSD2, ERC-4337, H.R. 8957 |
| AI models & products | 24 | ChatGPT, Claude Opus 4.8, Gemma 4, CUDA |
| Places | 24 | Ukraine, Sverige, Wisconsin, Strait of Hormuz |

**Fix:** widen the `entity_type` enum beyond `company | person` to
`company, person, investor, regulator, media, event, academic, protocol, token,
standard, product, place, concept`. Classify at extraction time, in the same LLM
call that names the entity — it is nearly free there and expensive later. Back
it with a deterministic stoplist/regex net for the mechanical cases (all-caps
tickers, `ERC-*`/`EIP-*`/`H.R.*`, lowercase common nouns, known regulator and VC
lists). Only `company` enters the sourcing funnel; the rest stay as context.

A working version of that filter is in `triage.py` — it removes ~87% of the
noise and cuts 1,825 rows to 232 reviewable candidates.

**The reclassification is ready to run.** `reclassify_entities.py` emits
`reclassification.json` (reviewable) and `reclassification.sql`, covering
1,593 of the 1,825 rows:

| Proposed type | Rows | Examples |
|---|---:|---|
| stays `company`, `is_eligible=false` | 902 | incumbents, late-stage, off-thesis |
| `concept` | 136 | `banks`, `stablecoins`, `Ethereum core devs` |
| `token` | 111 | USDC, USDT, XAU₮, A7A5 |
| `investor` | 105 | a16z, Paradigm, Balderton, BlueYard |
| `regulator` | 97 | SEC, FCA, CNMV, CFTC, OCC |
| `media` | 30 | Breakit, Bankless, Bloomberg, Fortune |
| `standard` | 29 | MiCA, GDPR, EIP-8037, ERC-8004 |
| `product` | 24 | ChatGPT, Claude, Qwen, Kimi |
| `place` | 24 | Ukraine, Russia, Denmark, Singapore |
| `association` | 22 | European Blockchain Association, World Gold Council |
| `event` | 21 | Paris Blockchain Week, Money20/20, Point Zero Forum |
| `academic` | 11 | KTH, Cambridge Judge, Handelshögskolan |

232 rows survive as genuine candidate companies — **13% of the table**. The SQL
requires migration 006 first, since it widens the enum. Review the JSON before
running it: the residual error rate is small but real (`CMTA` lands in `token`
because it is four capitals; `Australia's Senate Economics Legislation
Committee` lands in `event`).

**The person table has the same disease, mildly.** 50 of 891 rows (5.6%) are
not people — `Algorand Foundation`, `Linux Foundation`, `OP Mainnet`,
`Stockholm University`, `Lazarus Group`, `Värde Partners`, `Sonder Inc.`,
`ERC-3643 Association`. Worth the same classifier pass, but it is a rounding
error next to the company table's 87%.

## Layer 1 — Identity: one company, one row

Duplicates confirmed by the scoring agents: **Obsidion (1811) and ZKPassport
(1812) are the same company** — Obsidion Labs built ZKPassport, and Aztec Labs
acquired the team on 27 May 2026. The same pattern runs through the table:
`Centrifuge`/`Centrifuge Labs`, `Polygon`/`Polygon Labs`,
`LayerZero`/`LayerZero Labs`, `Ondo`/`Ondo Finance`, `FCA`/`Financial Conduct
Authority`/`Financial Conduct Authority (FCA)`, `BCG`/`Boston Consulting Group`.

**Fix:** resolve identity on **canonical domain, not display name**. A company
row without a resolvable own-domain is a candidate, not a company. Merge on
domain; keep aliases in `metadata`.

**Name collisions are systemic, not incidental.** In the payments slice alone,
four of six names collided with unrelated companies: `Unblock` vs UnblockPay
(Brazil, $20.6m raised); `Outpost` vs Outpost24, Outpost Space and AWS Outposts;
`Zapp` across a VocaLink scheme, a $300m grocery-delivery app and a Nasdaq-listed
EV maker; `Cadastral` turned out to be a New York proptech captured on a word
collision with "cadastral" in land-registry tokenisation articles. Without a
**domain or registry number pinned at capture**, the scorer will confidently
score the wrong company — and a confident wrong answer is worse than a gap.

## Layer 2 — Profile: describe the company, not the article

**Now:** `Entity.description` is the summary of whichever finding mentioned it.
Dfns, Turnkey, Para, Dynamic and Range carry **byte-identical descriptions**
because they appeared in one partner list — and all score exactly 0.622.
`thesis_tags` are derived the same way, from co-mention text.

**Fix:** the entity profile must come from an entity-level research pass against
the company's **own** domain, and never inherit article text. Thesis tags derive
from that profile. Until this is fixed, every downstream number is a property of
the news cycle rather than of the company.

## Layer 3 — Eligibility gate, before scoring

**Now:** nothing filters for the thesis. `WatchTarget.status` is set to `active`
whenever band is `strong` or `moderate`, so effectively everything is active.

**Fix:** store the 7 gates as first-class fields on the company and evaluate
them **before** any score exists:

| Gate | Test |
|---|---|
| G1 | European HQ / operating entity / regulatory home |
| G2 | Founded 2014 or later |
| G3 | pre-Seed / Seed / Series A |
| G4 | < €20m total raised |
| G5 | Sells to institutions, not retail-primary |
| G6 | Institutional digital-finance infrastructure — not app, token, fund, media |
| G7 | Independent and live — not acquired, dissolved, or an incumbent JV |

Any FAIL → `INELIGIBLE`, no score, never in picks. Ineligible companies stay in
the graph as context (you still want to know who Visa partnered with) but are
structurally barred from the ranking.

**Decision needed from the partners: is G4 a hard ceiling or a soft one?** This
is now the single highest-value question in the system, because it is what
rejects the good companies rather than the noise:

- **Dfns** — Paris, MPC key management, Standard Chartered and Kraken as named
  customers. Raised ~€27–28m. Fails G4 only.
- **Spiko** — Paris, tokenised money-market funds, MiCA-native. Raised €4m
  pre-seed + €18.9m Series A ≈ €22.9m. Fails G4 only, by ~€3m, after one round.

Both are close to perfect thesis fits and both are out by capital raised. That
points at a sourcing-timing problem, not a screening problem: by the time a
European infrastructure company is prominent enough to surface in the sources
this pipeline reads, it has usually already raised past the ceiling or been
acquired (Backed Finance → Kraken at ~$11m raised in under four years;
Obsidion → Aztec Labs; Unloq → iWelcome). The console therefore needs a
**stage-drift alert** — flag a company the quarter it approaches the cap — far
more than it needs a weekly re-rank of a static list.

### Two gate-wording traps found while testing it

1. **G1 must say "primary entity and regulatory home", not "has a European
   entity".** As first drafted, the FAIL condition read "HQ outside Europe with
   no European operating entity" — which Anthropic *literally passes*, because
   it has Dublin, London, Zurich, Paris and Munich offices. Any US large-cap
   with an EMEA subsidiary would slip straight back through the gate that exists
   to stop it. Fixed in the contract.
2. **Holding shells are not European entities.** Justoken presents as European
   via a dormant-style UK holding company (Universal Demeter Ltd, 13619598)
   while operating from Buenos Aires and São Paulo. G1 must test the *operating*
   entity.

## Layer 4 — Scoring: evidence, not popularity

Delete these components from `process_entity_scorer_job`:

- `evidence_depth = log1p(finding_count)/log(6)` — pure mention count, maxed for
  287 companies. This is the popularity term.
- `thesis_fit = len(thesis_tags)/3` — maxed for 131 companies, and derived from
  co-mention text anyway.
- `stage_fit`, `europe_relevance` — keyword hits in *article* text, so an
  article saying "Anthropic raised…" credits Anthropic with stage fit.

Replace with facts established at the gate (stage, geography, raise) plus the
signal scan. And fix the scan arithmetic in `compute_scan_scoring`:

```python
RESULT_CREDIT = {"confirmed": 1.0, "unknown": 0.5, "absent": 0.0}   # now
```

`unknown` must be **excluded from both numerator and denominator**, not given
half credit:

```
fit      = earned / resolved          # resolved = confirmed + absent only
coverage = resolved / assessed        # reported separately, never blended in
```

Band only when `coverage >= 0.40`; below that the verdict is
`insufficient-evidence`, not `moderate`. Today Securitize is the #1 weekly pick
at 50.8% "moderate" on 3 confirmed / 2 absent / **58 unknown** — coverage 0.08.
Under the fix it is unrankable, which is the honest answer.

### The console surface itself

`PicksPage.tsx` renders a "rising unscanned" table straight off
`heuristic_score` (line 103), and `CompaniesPage.tsx` shows it as a column
(line 96). That table is where "the most suggested companies are Anthropic"
actually comes from — `/picks` fills it from `EntityScore.score desc` with no
filter beyond "not yet scanned". Until Layer 4 lands, that list should be gated
on the eligibility flags or removed; a number displayed to two decimal places
reads as precision the underlying score does not have.

### The signal library has a vertical bias

The 200 signals are heavily weighted to payments and crypto licensing. An
identity company takes automatic `N` on EBA/EMI, FCA authorisation, VASP
registration, MiCAR whitepaper and MLRO signals that are genuinely
**not applicable** to it, while its real regulatory moat — eIDAS 2.0, QTSP
status, EUDI ARF conformance, national eID scheme integrations — is covered by
roughly four signals.

That is a scoring bug, not a company weakness: inapplicable signals are being
counted as absent. Two fixes, either works:

- mark signals **not-applicable** per vertical and exclude them from `resolved`
  exactly as `?` is excluded; or
- add an identity-specific regulatory sub-library (and, in time, one per
  vertical) so each company is scored against signals that could actually be
  true of it.

Do this before scoring more of the identity & permissioning vertical, or the
fund will systematically under-rank the segment its thesis names first.

## Layer 5 — Liveness: companies die

Three of six companies in the wallets slice no longer exist independently —
Unloq acquired 2019 and dissolved 20 May 2025, Obsidion and ZKPassport absorbed
by Aztec Labs 27 May 2026. Nothing in the pipeline notices.

**Fix:** a quarterly liveness sweep against Companies House, Handelsregister,
Bolagsverket, RCS and equivalents. Mark `acquired` / `dissolved` / `live`.
Acquired and dissolved companies drop out of picks automatically.

**Licences decay silently, and company copy does not.** Unblock still advertises
FNTT VASP authorisation; the Lithuanian register carries it on the *former*-VASP
file, expired 31 Dec 2025, and it does not appear on the EU CASP register. The
same registry shows 1 employee as of April 2026 while three of four co-founders
have taken full-time roles elsewhere (Kraken, Barclaycard, InfobelPRO). None of
that is visible from the website — and the website is what the scanner reads.

A lapsed licence is the **highest-value negative signal in the entire library**,
and it is precisely the one that never announces itself. Licence status must be
re-verified against EBA / ESMA / national registers on a schedule, not captured
once at scan time. Treat register state as the source of truth and company copy
as a claim.

## Layer 6 — Source mix: the edge is in the registers

Company attributions by source category:

| Source category | Companies surfaced |
|---|---:|
| newsletter | 1,491 |
| company | 214 |
| association | 206 |
| person | 152 |
| conference | 65 |
| vc | 37 |
| **regulator** | **19** |

Newsletters write about incumbents, so a newsletter-fed funnel returns
incumbents. The fund's stated edge is regulatory, and regulators are the
thinnest source in the system by an order of magnitude.

**Fix — register-first discovery.** This was tested, not theorised. A manual
sweep across registers, sandboxes, consortium rosters, accelerator cohorts and
specialist VC portfolios produced **181 unique on-thesis European companies from
109 distinct sources**, against the 4 investable companies the existing
1,825-row newsletter-fed pipeline had produced. Yield by source category:

| Source category | Companies |
|---|---:|
| association / member directory | 31 |
| ecosystem directory | 31 |
| regulatory register | 30 |
| VC portfolio | 25 |
| sandbox / pilot cohort | 25 |
| accelerator cohort | 22 |
| consortium roster | 10 |
| conference exhibitor list | 7 |

Geography of the pool: UK 42, Switzerland 24, Germany 22, France 16,
Netherlands 12, Sweden 8, Luxembourg 7, Italy 6, Spain 6, Denmark 5,
Austria 5, Belgium 5, Lithuania 3, Ireland 3.

**The specific lists to wire in, ranked by measured yield:**

| Source | Cadence | Why |
|---|---|---|
| WE BUILD Consortium organisations | quarterly | 200+ named EUDI vendors by country; richest single list found |
| Bank of England Digital Securities Sandbox | monthly | Named participants at exactly the right stage |
| FCA Regulatory Sandbox accepted firms | monthly | Every cohort, all years |
| Blockchain Bundesverband members | quarterly | 94 named German firms with domains |
| INATBA members (micro + small tiers) | quarterly | Paid membership filters out hobby projects |
| Tenity cohort announcements | quarterly | Each post lists every company with its domain inline |
| Crypto Valley Association corporate directory | monthly | 128 startups + 48 enterprise in raw HTML `data-` attributes; one curl |
| Fabric Ventures portfolio | monthly | Tags all 111 companies with country and founding year |
| Seedcamp portfolio | monthly | Self-groups by "Identity & Verification" and "Compliance & AML/KYC" |
| Motive Partners portfolio | quarterly | Zero consumer fintech; venture/growth split does the stage filter |
| EU Trusted List (`ec.europa.eu/tools/lotl/eu-lotl.xml`) | monthly diff | Every eIDAS QTSP in the EU, machine-readable |
| UK DIATF certified providers | weekly | Fastest-moving identity register in Europe |
| EBAday Fintech Zone finalists + exhibitors | annual | Screened from 70+ applicants by transaction-banking judges |
| ESMA DLT Pilot Regime authorisations | quarterly | Tiny list, enormous signal — this is how 21X and Axiology surfaced |

Two ingestion caveats learned the hard way: several directories still list
companies that have died or been acquired, and two had moved domains — so any
ingestion of these needs a **liveness and redirect check** on the company's own
domain or it will keep re-importing ghosts. And FINMA-style registers are
authoritative but thin (5 fintech licensees, 1 DLT trading facility), so they
are a verification tool more than a discovery tool.

### Identity signals the library is missing entirely

eIDAS 2.0 has created a set of registers that did not exist when the 200-signal
library was written, and they are the highest-resolution identity signals in
Europe: **per-member-state Relying Party Registers** (every party wanting wallet
credentials must register by name), the Commission's forthcoming **age-verification
trusted provider list**, **national EUDI sandbox participant lists** (France and
Germany live), and the new **qualified service types** — qualified EAA,
e-archiving, electronic ledger — where incumbents have no head start. The
December 2026 public / December 2027 private acceptance deadlines also work as a
round-timing predictor.

## Layer 7 — Close the loop

The doc's real ambition is signals that *predict*. That needs outcome data:
record, per signal, whether companies confirming it later raised a Series B,
signed a Tier-1 institution, or exited. After ~18 months the category weights
stop being my judgement and start being the fund's evidence. Store
`signal_id → entity_id → outcome → date` from the start, even while N is small —
it cannot be reconstructed retroactively.

---

## Order of work

1. **Layer 0 + 1** (typing + dedup) — without these nothing downstream is
   meaningful. Biggest single cleanup: 1,825 → ~230 real companies.
2. **Layer 3** (gate) — stops incumbents ranking, immediately.
3. **Layer 4** (scoring arithmetic) — small, contained, high-leverage.
4. **Layer 2** (entity-level profiles) — the expensive one; needs a research
   pass per company.
5. **Layer 6** (register sources) — this is what actually fills the funnel with
   on-thesis companies.
6. **Layers 5 + 7** — hygiene and compounding value.

Layers 0, 3 and 4 are roughly a day of work and fix the visible problem. Layer 6
is the one that changes what the fund sees.

---

## Appendix — running a discovery sweep again

Notes from the 2026-07-29/30 run, so the next one is cheaper.

- **Registers and cohort lists beat search.** Almost every good company came
  from a *list* — a register, a cohort, a member directory, a portfolio page —
  not from a search query. Point agents at named lists, not at topics.
- **Parallelism has a hard ceiling.** 33 concurrent agent sessions exhausted the
  Claude account's session limit outright and pushed machine load to 55. Eight
  to twelve concurrent sessions is the working range; beyond that the marginal
  session costs more than it returns.
- **Use two providers.** When one account hits its limit, the run continues on
  the other. `codex exec --enable web_search -s workspace-write` has its own
  quota and its own search, and produced the top of the current shortlist.
- **Make agents write incrementally.** Sessions die — API stalls, rate limits,
  watchdogs. An agent that writes its JSON after every company loses one
  company; an agent that writes at the end loses everything. Roughly a third of
  the sessions in this run died before finishing.
- **Never let agents spawn their own subagents for this.** A `claude -p` session
  that fans out hits a 600s background-wait ceiling, kills its own children and
  returns having written nothing. Set
  `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` or tell them to work inline.
- **Track in-flight claims.** A second wave launched while the first is still
  working will re-assign the same companies, because they are not yet in any
  output file. `inflight_claims.json` exists for this.
- **A dead session is recoverable.** Resuming it and asking only for
  serialisation — no new research — recovered every one that was asked, because
  the findings were still in its context.
- **Cross-check across models.** The shortlist was scored by two different
  models. Before trusting a merged ranking, blind re-score a few of one model's
  top results with the other. A cross-model score jump looks identical to a
  genuinely better company.
