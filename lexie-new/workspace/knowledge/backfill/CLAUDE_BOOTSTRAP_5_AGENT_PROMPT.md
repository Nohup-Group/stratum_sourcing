# Claude Bootstrap Review Prompt

Use this prompt with a Claude supervisor that can fan out work to 5 subagents in parallel.

## Goal

Review the existing Lexie session shards and propose **bootstrap-file updates only**.

Target files:

- `AGENTS.md`
- `SOUL.md`
- `IDENTITY.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `MEMORY.md`

Do **not** edit files directly. Only propose changes.

## Inputs

Read these first:

- `knowledge/backfill/manifests/session-inventory.md`
- `knowledge/backfill/manifests/candidate-facts.md`
- `knowledge/backfill/manifests/candidate-preferences.md`
- `knowledge/backfill/manifests/candidate-workflows.md`
- `knowledge/backfill/manifests/candidate-artifacts.md`
- `knowledge/backfill/manifests/conflicts.md`
- Current bootstrap files listed above

Then split transcript review across these shard assignments:

- Agent 1: `knowledge/backfill/shards/shard-01.md` and `knowledge/backfill/shards/shard-02.md`
- Agent 2: `knowledge/backfill/shards/shard-03.md` and `knowledge/backfill/shards/shard-04.md`
- Agent 3: `knowledge/backfill/shards/shard-05.md` and `knowledge/backfill/shards/shard-06.md`
- Agent 4: `knowledge/backfill/shards/shard-07.md` and `knowledge/backfill/shards/shard-08.md`
- Agent 5: `knowledge/backfill/shards/shard-09.md` and `knowledge/backfill/shards/shard-10.md`

## What counts as a bootstrap-worthy update

Promote only information that is:

1. stable across time
2. useful across many future conversations
3. specific enough to improve behavior
4. supported by transcript evidence

Good bootstrap candidates:

- stable identity facts about Lexie or Stratum
- recurring team structure and operator context
- durable operating rules
- reliable tool/integration facts
- recurring workflow rules
- stable communication preferences

Reject from bootstrap:

- one-off tasks
- temporary debugging notes
- transient inbox items
- stale incidents unless they define a lasting operating rule
- bulky research details better suited for `knowledge/*.md`
- raw transcript summaries

## Rules

1. Work only from the provided files and shard assignments.
2. Every proposed update must include provenance:
   - transcript file name(s)
   - short quote or paraphrase
   - reason it belongs in a bootstrap file
3. Do not invent facts.
4. Do not silently merge conflicting evidence.
5. If a fact belongs in `knowledge/*.md` rather than bootstrap, put it in `Out-of-Scope Followups`.
6. Prefer updating existing wording over adding duplicate bullets.
7. Keep `MEMORY.md` concise; it is for durable high-signal facts only.
8. Keep `HEARTBEAT.md` minimal; do not turn it into a dumping ground.
9. Keep `SOUL.md` about stable persona and behavior, not operational facts.
10. Keep `TOOLS.md` for durable tool/runtime/integration guidance, not ephemeral errors.

## Supervisor workflow

1. Dispatch the 5 subagents in parallel with their shard assignments.
2. Ask each subagent to return only:
   - proposed bootstrap updates by target file
   - evidence
   - conflicts
   - out-of-scope followups
3. Merge the subagent outputs.
4. Deduplicate overlapping proposals.
5. Produce one final review package for a human to approve.

## Required output format

Return one markdown document with these sections, in order:

1. `Executive Summary`
2. `AGENTS.md Proposed Updates`
3. `SOUL.md Proposed Updates`
4. `IDENTITY.md Proposed Updates`
5. `USER.md Proposed Updates`
6. `TOOLS.md Proposed Updates`
7. `HEARTBEAT.md Proposed Updates`
8. `MEMORY.md Proposed Updates`
9. `Conflicts`
10. `Out-of-Scope Followups`
11. `Do Not Change`

## Format for each proposed update

For every proposed update, use this exact structure:

`Target file:` `<file>`

`Proposed change:` a short patch-style bullet or replacement text

`Why:` why this improves future behavior

`Evidence:` transcript file(s) plus a short quote/paraphrase

`Confidence:` high, medium, or low

## Final filtering step

Before returning the final review, remove anything that fails one of these tests:

- Would this still be true in 30 days?
- Would Lexie need this in many future conversations?
- Does this belong in bootstrap rather than knowledge/artifacts/manifests?
- Is the evidence strong enough to justify promotion?

If the answer is no, do not include it in bootstrap proposals.
