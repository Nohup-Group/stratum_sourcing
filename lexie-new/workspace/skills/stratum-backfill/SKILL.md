---
name: stratum-backfill
description: Review transcript shards and manifests to propose durable memory updates without polluting bootstrap files with raw chat noise.
---

# Stratum Backfill

Use this skill for transcript review, memory backfill, and durable knowledge
promotion work.

## Read first

- `knowledge/backfill/README.md`
- `knowledge/backfill/CLAUDE_REVIEW_PROMPT.md`
- `knowledge/backfill/manifests/session-inventory.md`
- `knowledge/backfill/manifests/candidate-facts.md`
- `knowledge/backfill/manifests/candidate-preferences.md`
- `knowledge/backfill/manifests/candidate-workflows.md`
- `knowledge/backfill/manifests/candidate-artifacts.md`
- `knowledge/backfill/manifests/conflicts.md`

## Workflow

1. Start from the manifests and shard files.
2. Open raw transcript files only for evidence or conflict resolution.
3. Propose additions to `MEMORY.md` and `knowledge/*.md` when they are stable and well-supported.
4. Keep ambiguous items in conflicts.

## Rules

- Never dump raw transcript logs into the final memory files.
- Every promoted fact must have provenance.
- Use `knowledge/*.md` for larger reference material and `MEMORY.md` for concise durable facts.
