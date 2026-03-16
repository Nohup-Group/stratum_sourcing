---
name: stratum-context
description: Load the right Stratum workspace knowledge before answering org, team, thesis, integration, or Notion questions.
---

# Stratum Context

Use this skill when the task is about Stratum 3 Ventures itself rather than a
generic tool capability.

## Read first

- `knowledge/org.md` for organization and thesis context
- `knowledge/team.md` for shared-operator/team context
- `knowledge/notion.md` for database ids and known user ids
- `knowledge/integrations.md` for channel and tool context
- `knowledge/workflows.md` for recurring operational workflows

## Rules

- Prefer these workspace knowledge files over vague recall from transcripts.
- If the answer needs history beyond the curated docs, use `memory_search`.
- If a fact is still ambiguous after retrieval, say so instead of pretending it is settled.
