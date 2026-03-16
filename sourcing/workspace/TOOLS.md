# Tool Routing for Lexie Sourcing Agent

## Available Sidecar Endpoints

All endpoints hit the FastAPI sidecar at `http://localhost:8081`.

### Search Findings (Primary)
```
GET /api/findings/search?q={query}&limit=10
```
Returns findings matching the text query, ordered by relevance score.
Use this as the **first tool call** for any question.

### List Top Findings
```
GET /api/findings?limit=20&status=new
```
Returns findings ordered by relevance_score DESC.
Filters: `status` (new/reviewed/actionable/dismissed), `limit`.

### List Sources
```
GET /api/sources?category={category}&active_only=true
```
Returns monitored sources and their status.
Categories: person, association, newsletter, university, conference, vc, regulator.

### Health Check
```
GET /healthz
```

## Tool Persistence Rules

- **Continue until evidence or blocker**: Don't abandon search after one empty result
- **Confirm task scope**: Before answering, verify you understand what the user is asking
- **Parallel tool calling**: If searching for multiple entities, make independent queries in parallel

## Search Strategy Ladder

For any user question, follow this search strategy in order:

### Level 1: Direct keyword search
```
GET /api/findings/search?q=MiCA regulation
```
Try the most specific terms from the user's question.

### Level 2: Entity-based search
```
GET /api/findings/search?q=BaFin
GET /api/findings/search?q=21x
```
Search for specific entities mentioned or implied.

### Level 3: Vertical-based search
```
GET /api/findings?limit=20&status=new
```
Browse recent findings if specific searches return nothing.

### Level 4: Category-filtered browse
```
GET /api/sources?category=regulator
```
Check which sources cover the topic and reference findings from those sources.

## Query Expansion Patterns

If the initial search returns no results, expand:
- "tokenisation regulation" → try "MiCA", "DLT Pilot", "eIDAS"
- "identity companies" → try "verifiable credentials", "digital identity", "KYC"
- "new startups" → try "funding round", "seed", "series a"
- "what changed" → search recent findings with no query filter (top by score)

## Response Packaging

1. **Answer first**: Lead with the direct answer
2. **Evidence block**: List supporting findings with [N] citations
3. **Gaps**: Note what the database doesn't cover
4. **Sources**: Mention which source categories the evidence came from

Example:
```
Based on the latest findings:

• MiCA implementation timeline has shifted to Q3 2026 [1]
• BaFin published new guidance on DLT custody requirements [2]
• Three European startups raised Seed rounds in compliance infrastructure [3][4][5]

[1] EU Commission DG FISMA update (2026-03-08) - "MiCA Level 2 delegated acts..."
[2] BaFin regulatory feed (2026-03-07) - "New requirements for DLT-based..."
[3] Bankless newsletter (2026-03-06) - "CompliChain raised €3M seed from..."

Note: No findings on eIDAS integration with blockchain in the last 7 days.
```
