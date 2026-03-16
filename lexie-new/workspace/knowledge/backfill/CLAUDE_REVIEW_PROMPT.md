# Claude Transcript Backfill Prompt

Use this prompt when dispatching a parallel Claude review team across the shard files in `knowledge/backfill/shards/`.

## Task

Review the assigned shard of Lexie transcript files and propose **durable Stratum knowledge** that should be added to:

- `AGENTS.md`
- `MEMORY.md`
- `knowledge/*.md`
- `knowledge/artifacts/*.md`

## Rules

1. Work only from the assigned shard plus the existing workspace docs and manifests.
2. Every proposed fact must include provenance:
   - transcript file name(s)
   - short evidence quote or paraphrase
   - why the fact is durable
3. Do **not** dump raw transcript logs into the output.
4. Do **not** invent missing facts.
5. Separate:
   - durable facts
   - preferences
   - workflows
   - artifacts
   - conflicts / unresolved ambiguity
6. If two sources disagree, put the item in conflicts instead of resolving it by guesswork.

## Output format

Return a markdown review with these sections:

1. `Durable Facts`
2. `Preferences`
3. `Workflows`
4. `Artifacts`
5. `Conflicts`
6. `Suggested File Updates`

For `Suggested File Updates`, provide patch-ready bullet points that say exactly
which target file should gain which fact.

## Promotion policy

- Auto-promote only facts that are repeated, stable, and clearly relevant beyond a single conversation.
- Keep one-off operational chatter, debugging noise, and raw automation output out of bootstrap files.
- Use `knowledge/*.md` for bulky reference material and `MEMORY.md` for concise durable facts.
