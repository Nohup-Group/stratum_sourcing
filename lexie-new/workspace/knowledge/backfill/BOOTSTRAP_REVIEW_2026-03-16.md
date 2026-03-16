# Bootstrap Review Package — 2026-03-16

## Executive Summary

Reviewed 10 shards across 5 parallel agents. Only shards 1–5 contained content (5 human-relevant sessions); shards 6–10 were empty. Of the 5 sessions, shard-03 was a heartbeat-only session (70 assistant messages, no users). The substantive material came from:

- **Shard-02** (Core Team S3V WhatsApp group): Notion task creation, Insight Library workflow, 21X/USMO analysis
- **Shard-04** (multi-channel: WhatsApp + Slack): Company research (Walt.id), calendar management, voice memos, infrastructure debugging, new team member Lukas Schmidt
- **Shard-05** (Stratum x Nohup WhatsApp group): Competition analysis request (21X), Johan Toll active

**Total proposals: 10** (after dedup). 5 high-confidence, 4 medium, 1 low.

---

## AGENTS.md Proposed Updates

### 1. Add language-awareness rule to Channel Behavior

Target file: `AGENTS.md`

Proposed change: Under `## Channel Behavior`, add:

```markdown
- Match the language of the sender when clear. Sören often writes in German;
  Jaime prefers English. When the language is ambiguous, default to English.
```

Why: The team uses Lexie in both German and English. Responding in the wrong language would be jarring. This is a durable behavioral rule, not a transient preference.

Evidence: Shard-04 (bc1ff9dc) — Sören writes in German ("wie kann ich den openai api key speichern", "wer bist du, was für documentation hast du"); Jaime explicitly states "I'm English" and writes only in English.

Confidence: **high**

---

## SOUL.md Proposed Updates

No changes proposed. Lexie's observed tone (concise, action-first, no fluff) matches the current SOUL.md across all shards.

---

## IDENTITY.md Proposed Updates

No changes proposed. Current content is accurate and complete.

---

## USER.md Proposed Updates

### 2. Expand recurring humans with identifiers, language preferences, and new members

Target file: `USER.md`

Proposed change: Replace the "Recurring humans" section with:

```markdown
## Recurring humans in the current corpus

- **Sören Zimmer** (+34744663924) — infrastructure/operator, bilingual (German/English)
- **Jaime Farré** (+34606561468) — business/operations, prefers English
- **Hanna Raftell** (+46738550578) — recurring Stratum team context
- **Johan Toll** (+46721504811) — recurring Stratum team context
- **Lukas Schmidt** — recurring Stratum team context (Slack: U0AC9GX69RV, WhatsApp: +4917622894081)
- **Jon Ardinast** — recurring Stratum contact (meeting attendee, role TBD)
```

Why: Phone numbers are the primary sender identity in WhatsApp group chats. Without this mapping, Lexie cannot reliably attribute requests to the correct team member. Language preferences help Lexie respond in the right language. Lukas Schmidt and Jon Ardinast are newly identified from transcripts.

Evidence:
- Shard-02 (2c8620b1): Jaime as +34606561468, Hanna as +46738550578
- Shard-04 (bc1ff9dc): Sören as +34744663924, Lukas Schmidt as U0AC9GX69RV / +4917622894081, Jon Ardinast as meeting attendee, Jaime states "I'm English"
- Shard-05 (ed19c715): Johan Toll as +46721504811

Confidence: **high** for all except Jon Ardinast (**medium** — only one mention as meeting attendee)

---

## TOOLS.md Proposed Updates

### 3. Resolve "Lukas" to "Lukas Schmidt" in Notion users

Target file: `TOOLS.md`

Proposed change: Change:
```
- Lukas: `212d872b-594c-81be-8d61-000229a7346d`
```
to:
```
- Lukas Schmidt: `212d872b-594c-81be-8d61-000229a7346d`
```

Why: Resolves the partial name "Lukas" to the full name for consistent identity resolution across all files.

Evidence: Shard-04 (bc1ff9dc) — Lukas Schmidt identified via Slack DM (U0AC9GX69RV). Small team size makes the identity merge high-confidence.

Confidence: **high**

---

### 4. Annotate Slack allowlist with channel owners (needs verification)

Target file: `TOOLS.md`

Proposed change: Under `## Slack`, add owner annotations to the allowlisted DM/channel IDs if the operator can confirm which belongs to whom. At minimum, note that Lukas Schmidt's Slack user ID is `U0AC9GX69RV` and verify his DM channel is in the allowlist.

Why: Bare channel IDs without labels are hard to maintain. Lukas is an active Slack DM user.

Evidence: Shard-04 (bc1ff9dc) — Lukas Schmidt DMs from Slack U0AC9GX69RV.

Confidence: **medium** — needs operator verification before changing the allowlist

---

## HEARTBEAT.md Proposed Updates

No changes proposed. Shard-03 confirms the heartbeat model is working as designed (quiet, no-human-interaction cron cycle). The current minimal HEARTBEAT.md is appropriate.

---

## MEMORY.md Proposed Updates

### 5. Add Lukas Schmidt to team context

Target file: `MEMORY.md`

Proposed change: Under `## Team context`, add to the recurring humans list:
```
  - Lukas Schmidt
```

Why: MEMORY.md lists the four known recurring humans. Lukas Schmidt is now confirmed as a fifth active team member across Slack and WhatsApp.

Evidence: Shard-04 (bc1ff9dc) — Lukas Schmidt DMs via both Slack and WhatsApp with substantive requests.

Confidence: **high**

---

## knowledge/notion.md Proposed Updates

### 6. Resolve "Lukas" to "Lukas Schmidt"

Target file: `knowledge/notion.md`

Proposed change: Change:
```
- Lukas: `212d872b-594c-81be-8d61-000229a7346d`
```
to:
```
- Lukas Schmidt: `212d872b-594c-81be-8d61-000229a7346d`
```

Why: Same as proposal 3. Both TOOLS.md and knowledge/notion.md carry this entry and should stay consistent.

Evidence: Shard-04 (bc1ff9dc).

Confidence: **high**

---

## knowledge/team.md Proposed Updates

### 7. Expand team roster with identifiers and roles

Target file: `knowledge/team.md`

Proposed change: Expand the "Recurring names" section:

```markdown
## Recurring names in the current corpus

- Jaime Farré — business/operations, prefers English
- Hanna Raftell
- Johan Toll
- Sören Zimmer — infrastructure/operator, bilingual (German/English)
- Lukas Schmidt — Slack: U0AC9GX69RV, WhatsApp: +4917622894081
- Jon Ardinast — meeting attendee (relationship TBD)
```

Why: Centralizes team identity resolution. The Slack ID and WhatsApp number for Lukas help Lexie correlate messages across channels.

Evidence: Shard-04 and Shard-05.

Confidence: **high** for Lukas; **medium** for Jon Ardinast

---

## knowledge/integrations.md Proposed Updates

### 8. Add known WhatsApp groups and voice memo support

Target file: `knowledge/integrations.md`

Proposed change: Under `## Channel notes`, add:

```markdown
- Known WhatsApp groups:
  - "Core Team S3V" — internal S3V team group
  - "Stratum x Nohup" — cross-team group between S3V and Nohup
- Voice memos are sent via WhatsApp. Lexie processes audio messages and responds
  to their content. Whisper transcription handles audio-to-text.
```

Why: The existing notes say WhatsApp is enabled but list no groups. Knowing the group names helps Lexie understand channel context (e.g., "Stratum x Nohup" includes external participants). Voice memos are actively used by multiple team members and are a durable channel capability.

Evidence:
- Shard-02 (2c8620b1): Messages in "Core Team S3V" group
- Shard-05 (ed19c715): Messages in "Stratum x Nohup" group
- Shard-04 (bc1ff9dc): Lukas asks "do you understand voice memos?"; Jaime sends WhatsApp audio messages; Sören asks about Whisper transcription

Confidence: **high** for voice memos; **medium** for group names (durable but only observed in one session each)

---

## knowledge/workflows.md Proposed Updates

### 9. Add company research and competition analysis as recurring workflows

Target file: `knowledge/workflows.md`

Proposed change: Add:

```markdown
## Company research and competition analysis

Observed recurring workflow from the transcript corpus:

- Team members ask Lexie to research a company before calls or as part of pipeline work.
- Typical requests: "tell us about [company] and how it's relevant to us",
  "validate these assumptions on competition analysis between [company A] and [company B]"
- Expected output: company overview, relevance to S3V thesis areas, funding status,
  regulatory context, competitive landscape.
- Use web search, Notion Pipeline Companies database, and existing artifacts as sources.
- Frame relevance against the S3V thesis (Identity & Permissioning, Wallets & Key Management,
  Compliance & Trust, Data Oracles & Middleware).
```

Why: Company research and competition analysis requests appear as a recurring pattern across multiple shards and team members. Having this documented means Lexie knows the expected output format and thesis framing without being told each time.

Evidence:
- Shard-04 (bc1ff9dc): Jaime asks "can you let us know a bit about [Walt.id] and how its relevant to us?"; follow-ups about EIDAS2 and funding
- Shard-05 (ed19c715): Johan asks for "competition analysis between 21x..."

Confidence: **medium** — two independent instances across different shards and team members, but still limited sample size

---

## Conflicts

1. **Jon Ardinast's role**: Only mentioned once as a Google Meet attendee. Unclear whether team member, external advisor, or portfolio company contact. Added to USER.md and knowledge/team.md with "role TBD" qualifier. Do not promote to full team member without more evidence.

2. **Lukas identity merge**: The bootstrap files have "Lukas" in Notion user IDs. Shard-04 introduces "Lukas Schmidt" via Slack and "LS (+4917622894081)" via WhatsApp. High confidence these are the same person given the small team size, but technically an inference.

3. **Phone numbers in workspace files**: Agents 1 and 3 flagged potential privacy concerns about storing personal phone numbers. Since these numbers are already present in WhatsApp gateway metadata that Lexie processes in every session, storing them in USER.md for identity resolution is pragmatically necessary. However, the operator should confirm this is acceptable.

---

## Out-of-Scope Followups

These items surfaced in the review but belong in `knowledge/*.md` or `memory/` rather than bootstrap files:

1. **"Insight Library" workflow**: Hanna asks Lexie to "add to Insight Library" twice. Likely a Notion database or section. Worth documenting in `knowledge/notion.md` or `knowledge/workflows.md` once the database ID and schema are confirmed. We do not yet know if it maps to "Document Hub" or is separate.

2. **"S3V Limited Partners" Notion page**: Jaime asks to update "Last Contact Date" for Alexander Gunz. Likely maps to Investor CRM database. The specific contact (Alexander Gunz) is ephemeral data, not a bootstrap fact.

3. **Walt.id company profile**: If Walt.id is in the Notion pipeline, a `knowledge/artifacts/walt-id.md` digest may be warranted. This is reference material, not bootstrap.

4. **21X as a pipeline company**: One mention in competition analysis context. Better captured in Notion Pipeline Companies database than hardcoded in bootstrap files. The existing workflow guidance already covers this.

5. **Adam Demo Practice Run meeting**: Specific meeting on 2026-03-16. Not durable — belongs in `memory/2026-03-16.md` at most.

6. **OpenAI API key for Whisper**: Sören's question is an infrastructure/ops task, not a bootstrap fact. The durable takeaway (voice memo support) is captured in proposal 8.

7. **WhatsApp group "Core Team S3V"**: Already captured in proposal 8 under integrations.

---

## Do Not Change

- **SOUL.md**: No new personality or communication style evidence. Current content is complete.
- **HEARTBEAT.md**: Shard-03 confirms the heartbeat model works. No changes needed.
- **IDENTITY.md**: No new identity facts beyond what is captured.
- **Existing Notion database IDs**: All confirmed correct by usage in transcripts.
- **Existing Slack allowlist**: Do not modify without operator verification.
- **MEMORY.md thesis areas**: Already accurate ("Identity & Permissioning, Wallets & Key Management, Compliance & Trust, Data Oracles & Middleware") — validated by company research context in shards.

---

## Summary Table

| # | Target File | Change | Confidence | Action |
|---|------------|--------|------------|--------|
| 1 | AGENTS.md | Language-awareness rule | High | Apply |
| 2 | USER.md | Expand humans + identifiers + language prefs | High | Apply |
| 3 | TOOLS.md | Lukas → Lukas Schmidt | High | Apply |
| 4 | TOOLS.md | Annotate Slack allowlist owners | Medium | Needs verification |
| 5 | MEMORY.md | Add Lukas Schmidt | High | Apply |
| 6 | knowledge/notion.md | Lukas → Lukas Schmidt | High | Apply |
| 7 | knowledge/team.md | Expand roster + identifiers + roles | High | Apply |
| 8 | knowledge/integrations.md | WhatsApp groups + voice memos | High | Apply |
| 9 | knowledge/workflows.md | Company research + competition analysis | Medium | Apply |
| 10 | *(dropped)* | 21X as known company in MEMORY.md | Low | Skip |
