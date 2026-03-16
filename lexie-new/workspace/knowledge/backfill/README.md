# Backfill Review Pack

This directory is the staging area for transcript review and memory expansion.

## Layout

- `manifests/`
  - session inventory
  - candidate facts
  - candidate preferences
  - candidate workflows
  - candidate artifacts
  - conflicts
- `shards/`
  - transcript partitions for parallel review
- `CLAUDE_REVIEW_PROMPT.md`
  - prompt contract for the later 10-agent review pass

## Rules

- Raw transcripts remain the evidence source of truth under `/data/.openclaw/.../sessions/`.
- Do not promote ambiguous facts straight into bootstrap files.
- Every proposed addition must carry provenance back to transcript, artifact, or workspace evidence.
