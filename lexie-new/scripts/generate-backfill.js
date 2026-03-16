#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");

const DEFAULT_WORKSPACE_ROOT =
  process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace";
const DEFAULT_STATE_ROOT = process.env.OPENCLAW_STATE_DIR || "/data/.openclaw";
const SHARD_COUNT = 10;

const FACT_CANDIDATES = [
  {
    id: "org-name",
    statement: "Lexie operates for Stratum 3 Ventures, also referred to as S3V.",
    keywords: ["stratum 3 ventures", "stratum 3ventures", "s3v"],
  },
  {
    id: "thesis",
    statement:
      "Stratum thesis language in the corpus consistently references Identity & Permissioning, Wallets & Key Management, Compliance & Trust, and Data Oracles & Middleware.",
    keywords: [
      "identity & permissioning",
      "wallets & key management",
      "compliance & trust",
      "data oracles & middleware",
    ],
  },
  {
    id: "team",
    statement:
      "The transcript corpus frequently references Jaime Farré, Hanna Raftell, Johan Toll, and Sören Zimmer as recurring humans around Lexie.",
    keywords: ["jaime", "hanna", "johan", "sören", "soren"],
  },
  {
    id: "lexie-email",
    statement:
      "Lexie uses lexie@stratum3ventures.com as a recurring shared mailbox identity in the transcript corpus.",
    keywords: ["lexie@stratum3ventures.com"],
  },
];

const WORKFLOW_CANDIDATES = [
  {
    id: "gmail-triage",
    title: "Inbox triage with Slack escalation",
    keywords: [
      "check gmail inbox",
      "alert via slack if",
      "complete silently",
      "skip spam/newsletters",
    ],
  },
  {
    id: "calendar-noise-filter",
    title: "Treat calendar RSVP noise as non-actionable",
    keywords: [
      "calendar acceptance/decline notifications",
      "accepted:",
      "declined:",
      "not actionable",
    ],
  },
  {
    id: "notion-support",
    title: "Notion pipeline and CRM support",
    keywords: ["notion", "pipeline", "investor crm", "meeting notes"],
  },
  {
    id: "gateway-ops",
    title: "Gateway restart and integration checks",
    keywords: ["restart the gateway", "restart the gateway?", "pairing", "skills"],
  },
];

const PREFERENCE_HINTS = [
  {
    id: "quiet-ops",
    description:
      "Operational automations should stay quiet when nothing actionable exists.",
    keywords: ["complete silently", "nothing actionable", "HEARTBEAT_OK"],
  },
  {
    id: "actionable-only-alerts",
    description:
      "Escalations should focus on actionable items, not routine notification noise.",
    keywords: ["needs attention", "not actionable", "calendar acceptance/decline notifications"],
  },
];

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeText(filePath, contents) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, contents, "utf8");
}

async function writeJson(filePath, value) {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readTextSafe(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function extractUserText(event) {
  const parts = event?.message?.content || [];
  return parts
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n");
}

function extractAttachmentRecords(transcriptText) {
  const records = [];
  const matches = transcriptText.matchAll(
    /attachment\t([^\t\n]+)\t([^\t\n]+)\t([^\t\n]+)(?:\t([^\t\n]+))?/g,
  );
  for (const match of matches) {
    records.push({
      filename: match[1],
      size: match[2] || null,
      mimeType: match[3] || null,
      attachmentId: match[4] || null,
    });
  }
  return records;
}

function collectKeywordEvidence(stats, keywords) {
  const loweredKeywords = keywords.map((keyword) => keyword.toLowerCase());
  const matchedSessions = stats.filter((item) =>
    loweredKeywords.some((keyword) => item.text.includes(keyword)),
  );
  return {
    sessionCount: matchedSessions.length,
    sampleSessions: matchedSessions.slice(0, 8).map((item) => item.fileName),
  };
}

async function inspectActiveSession(filePath, referencedSet) {
  const raw = await readTextSafe(filePath);
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let firstUserText = "";
  let messageCount = 0;
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "message") {
        messageCount += 1;
        if (event.message?.role === "user" && !firstUserText) {
          firstUserText = extractUserText(event);
        }
      }
    } catch {
      continue;
    }
  }

  const transcriptText = raw.toLowerCase();
  const fileName = path.basename(filePath);
  const isCron =
    firstUserText.startsWith("[cron:") ||
    transcriptText.includes("check gmail inbox") ||
    transcriptText.includes("heartbeat_ok");
  const isOperational =
    isCron ||
    transcriptText.includes("restart the gateway") ||
    transcriptText.includes("pairing required");
  const isHumanRelevant =
    !isCron &&
    (transcriptText.includes("stratum") ||
      transcriptText.includes("notion") ||
      transcriptText.includes("pipeline") ||
      transcriptText.includes("jaime") ||
      transcriptText.includes("hanna") ||
      transcriptText.includes("johan") ||
      transcriptText.includes("sören") ||
      transcriptText.includes("soren") ||
      transcriptText.includes("attachment\t") ||
      firstUserText.length > 0);

  return {
    fileName,
    filePath,
    referenced: referencedSet.has(path.basename(filePath, ".jsonl")),
    messageCount,
    firstUserText,
    isCron,
    isOperational,
    isHumanRelevant,
    text: transcriptText,
    attachments: extractAttachmentRecords(raw),
  };
}

async function collectWorkspaceArtifacts(workspaceRoot) {
  const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
  const interesting = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (![".pdf", ".docx", ".zip", ".html", ".md", ".json"].includes(ext)) {
      continue;
    }
    const fullPath = path.join(workspaceRoot, entry.name);
    const stat = await fs.stat(fullPath);
    interesting.push({
      fileName: entry.name,
      path: fullPath,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  }
  interesting.sort((left, right) => left.fileName.localeCompare(right.fileName));
  return interesting;
}

function renderInventoryMarkdown(inventory) {
  return `# Session Inventory

- Active transcript files: ${inventory.activeCount}
- Referenced sessions in \`sessions.json\`: ${inventory.referencedCount}
- Orphan active transcripts: ${inventory.orphanCount}
- Deleted transcript files: ${inventory.deletedCount}
- Reset transcript files: ${inventory.resetCount}
- Human-relevant active sessions: ${inventory.humanRelevantCount}
- Operational or cron-heavy sessions: ${inventory.operationalCount}

## Notes

- "Referenced" means the session id currently appears in \`sessions.json\`.
- "Orphan" means the transcript still exists but is not referenced by current routing metadata.
- Human relevance is heuristic. Use the shard lists for deeper review before promoting new durable facts.
`;
}

function renderCandidateFactsMarkdown(stats) {
  const lines = ["# Candidate Facts", ""];
  for (const candidate of FACT_CANDIDATES) {
    const evidence = collectKeywordEvidence(stats, candidate.keywords);
    lines.push(`## ${candidate.id}`);
    lines.push(`- Candidate: ${candidate.statement}`);
    lines.push(`- Matching sessions: ${evidence.sessionCount}`);
    lines.push(
      `- Sample evidence sessions: ${
        evidence.sampleSessions.length > 0
          ? evidence.sampleSessions.map((item) => `\`${item}\``).join(", ")
          : "none yet"
      }`,
    );
    lines.push("");
  }
  lines.push(
    "Phase 1 auto-promotes only the highest-confidence basics into `MEMORY.md` and `knowledge/*.md`. Use the later shard review pass to expand this set.",
  );
  lines.push("");
  return lines.join("\n");
}

function renderPreferenceMarkdown(stats) {
  const lines = ["# Candidate Preferences", ""];
  for (const hint of PREFERENCE_HINTS) {
    const evidence = collectKeywordEvidence(stats, hint.keywords);
    lines.push(`## ${hint.id}`);
    lines.push(`- Candidate: ${hint.description}`);
    lines.push(`- Matching sessions: ${evidence.sessionCount}`);
    lines.push(
      `- Sample evidence sessions: ${
        evidence.sampleSessions.length > 0
          ? evidence.sampleSessions.map((item) => `\`${item}\``).join(", ")
          : "none yet"
      }`,
    );
    lines.push("");
  }
  lines.push(
    "No person-specific communication preferences were auto-promoted in Phase 1 without stronger review evidence.",
  );
  lines.push("");
  return lines.join("\n");
}

function renderWorkflowMarkdown(stats) {
  const lines = ["# Candidate Workflows", ""];
  for (const workflow of WORKFLOW_CANDIDATES) {
    const evidence = collectKeywordEvidence(stats, workflow.keywords);
    lines.push(`## ${workflow.title}`);
    lines.push(`- Matching sessions: ${evidence.sessionCount}`);
    lines.push(
      `- Sample evidence sessions: ${
        evidence.sampleSessions.length > 0
          ? evidence.sampleSessions.map((item) => `\`${item}\``).join(", ")
          : "none yet"
      }`,
    );
    lines.push("");
  }
  return lines.join("\n");
}

function renderConflictsMarkdown() {
  return `# Conflicts and Drift

## Bootstrap drift fixed in Phase 1

- Previous bootstrap content treated Lexie as if one primary human existed. The workspace now uses a shared-operator model instead.
- Previous workspace files mixed stale operational state from early February 2026 with current runtime behavior. Stable facts were retained, but operational status was moved out of long-term memory.
- Previous runtime pathing resolved workspace context through \`/root/.openclaw/workspace\`. Phase 1 normalizes OpenClaw home to \`/data\`.
- Historical session metadata can still reference \`/openclaw/skills/*\` paths from the old source-build layout. The service now provides a compatibility symlink, but old transcript snapshots should still be treated as historical evidence, not canonical runtime state.

## Review policy

- Promote only stable, repeated, high-confidence facts into bootstrap files.
- Keep ambiguous team/user ownership, artifact mapping, and operational history in manifests until reviewed.
- Do not use stale bootstrap content as primary evidence if transcripts or current workspace state disagree.
`;
}

function renderArtifactMarkdown(attachments, workspaceArtifacts) {
  const lines = ["# Candidate Artifacts", ""];

  lines.push("## Attachment evidence from transcripts");
  if (attachments.length === 0) {
    lines.push("- No attachment records were parsed from the transcript corpus.");
  } else {
    for (const attachment of attachments.slice(0, 30)) {
      lines.push(
        `- \`${attachment.filename}\` — size: ${attachment.size || "unknown"}, mime: ${
          attachment.mimeType || "unknown"
        }, seen in ${attachment.sourceSessions.length} session(s): ${attachment.sourceSessions
          .slice(0, 5)
          .map((item) => `\`${item}\``)
          .join(", ")}`,
      );
    }
  }
  lines.push("");

  lines.push("## Workspace files");
  if (workspaceArtifacts.length === 0) {
    lines.push("- No interesting workspace artifacts were found at the workspace root.");
  } else {
    for (const artifact of workspaceArtifacts) {
      lines.push(
        `- \`${artifact.fileName}\` — ${artifact.sizeBytes} bytes, modified ${artifact.modifiedAt}, path \`${artifact.path}\``,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

function renderWorkspaceArtifactDigest(workspaceArtifacts) {
  const lines = [
    "# Workspace Artifact Digest",
    "",
    "This file is generated from the current workspace root. It is a curated index, not a claim that every file is important.",
    "",
  ];

  if (workspaceArtifacts.length === 0) {
    lines.push("- No root-level artifacts were detected.");
    lines.push("");
    return lines.join("\n");
  }

  for (const artifact of workspaceArtifacts) {
    lines.push(`## ${artifact.fileName}`);
    lines.push(`- Path: \`${artifact.path}\``);
    lines.push(`- Size: ${artifact.sizeBytes} bytes`);
    lines.push(`- Modified: ${artifact.modifiedAt}`);
    lines.push("- Provenance: present on the live Lexie workspace volume during Phase 1 bootstrap.");
    lines.push("");
  }

  return lines.join("\n");
}

function renderAttachmentDigest(attachments) {
  const lines = [
    "# Email Attachment Digest",
    "",
    "This file is generated from attachment metadata observed in transcript tool output.",
    "",
  ];

  if (attachments.length === 0) {
    lines.push("- No attachment metadata was found in the transcript corpus.");
    lines.push("");
    return lines.join("\n");
  }

  for (const attachment of attachments.slice(0, 50)) {
    lines.push(`## ${attachment.filename}`);
    lines.push(`- Size: ${attachment.size || "unknown"}`);
    lines.push(`- MIME type: ${attachment.mimeType || "unknown"}`);
    lines.push(
      `- Provenance sessions: ${attachment.sourceSessions
        .slice(0, 8)
        .map((item) => `\`${item}\``)
        .join(", ")}`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

async function buildShards(targetDir, sessions) {
  const shards = Array.from({ length: SHARD_COUNT }, (_, index) => ({
    shard: index + 1,
    files: [],
  }));

  sessions.forEach((session, index) => {
    shards[index % SHARD_COUNT].files.push(session);
  });

  for (const shard of shards) {
    const header = [
      `# Shard ${String(shard.shard).padStart(2, "0")}`,
      "",
      `- Session count: ${shard.files.length}`,
      "",
    ];
    const body = shard.files.map(
      (item) =>
        `- \`${item.fileName}\` | referenced=${item.referenced} | messages=${item.messageCount} | first user text: ${JSON.stringify(
          item.firstUserText.slice(0, 180),
        )}`,
    );
    await writeText(
      path.join(targetDir, `shard-${String(shard.shard).padStart(2, "0")}.md`),
      `${header.concat(body).join("\n")}\n`,
    );
  }

  return shards.map((shard) => ({
    shard: shard.shard,
    sessionCount: shard.files.length,
    files: shard.files.map((item) => item.fileName),
  }));
}

async function generateBackfill(options = {}) {
  const workspaceRoot = options.workspaceRoot || DEFAULT_WORKSPACE_ROOT;
  const stateRoot = options.stateRoot || DEFAULT_STATE_ROOT;
  const sessionsDir = path.join(stateRoot, "agents", "main", "sessions");
  const sessionsJsonPath = path.join(sessionsDir, "sessions.json");
  const backfillRoot = path.join(workspaceRoot, "knowledge", "backfill");
  const manifestsDir = path.join(backfillRoot, "manifests");
  const shardsDir = path.join(backfillRoot, "shards");
  const artifactsDir = path.join(workspaceRoot, "knowledge", "artifacts");

  await ensureDir(manifestsDir);
  await ensureDir(shardsDir);
  await ensureDir(artifactsDir);

  const sessionsJson = await readJsonSafe(sessionsJsonPath, {});
  const referencedIds = new Set(
    Object.values(sessionsJson)
      .map((entry) => entry && entry.sessionId)
      .filter(Boolean),
  );

  const entries = (await pathExists(sessionsDir))
    ? await fs.readdir(sessionsDir)
    : [];
  const activeFiles = entries
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(sessionsDir, name))
    .sort();
  const deletedFiles = entries
    .filter((name) => name.includes(".jsonl.deleted."))
    .sort();
  const resetFiles = entries.filter((name) => name.includes(".jsonl.reset.")).sort();

  const activeStats = [];
  for (const filePath of activeFiles) {
    activeStats.push(await inspectActiveSession(filePath, referencedIds));
  }

  const orphanFiles = activeStats
    .filter((item) => !item.referenced)
    .map((item) => item.fileName);
  const humanRelevantSessions = activeStats.filter((item) => item.isHumanRelevant);
  const operationalSessions = activeStats.filter((item) => item.isOperational);

  const attachmentMap = new Map();
  for (const item of activeStats) {
    for (const attachment of item.attachments) {
      const existing = attachmentMap.get(attachment.filename) || {
        ...attachment,
        sourceSessions: [],
      };
      if (!existing.sourceSessions.includes(item.fileName)) {
        existing.sourceSessions.push(item.fileName);
      }
      attachmentMap.set(attachment.filename, existing);
    }
  }
  const attachments = Array.from(attachmentMap.values()).sort((left, right) =>
    left.filename.localeCompare(right.filename),
  );

  const workspaceArtifacts = await collectWorkspaceArtifacts(workspaceRoot);
  const inventory = {
    activeCount: activeFiles.length,
    referencedCount: referencedIds.size,
    orphanCount: orphanFiles.length,
    deletedCount: deletedFiles.length,
    resetCount: resetFiles.length,
    humanRelevantCount: humanRelevantSessions.length,
    operationalCount: operationalSessions.length,
    referencedSessionKeys: Object.keys(sessionsJson).length,
    orphanFiles,
    deletedFiles,
    resetFiles,
  };

  const shardManifest = await buildShards(shardsDir, humanRelevantSessions);

  await writeJson(path.join(manifestsDir, "session-inventory.json"), inventory);
  await writeText(
    path.join(manifestsDir, "session-inventory.md"),
    renderInventoryMarkdown(inventory),
  );
  await writeText(
    path.join(manifestsDir, "candidate-facts.md"),
    renderCandidateFactsMarkdown(activeStats),
  );
  await writeText(
    path.join(manifestsDir, "candidate-preferences.md"),
    renderPreferenceMarkdown(activeStats),
  );
  await writeText(
    path.join(manifestsDir, "candidate-workflows.md"),
    renderWorkflowMarkdown(activeStats),
  );
  await writeText(
    path.join(manifestsDir, "candidate-artifacts.md"),
    renderArtifactMarkdown(attachments, workspaceArtifacts),
  );
  await writeText(
    path.join(manifestsDir, "conflicts.md"),
    renderConflictsMarkdown(),
  );
  await writeJson(path.join(shardsDir, "manifest.json"), shardManifest);
  await writeText(
    path.join(artifactsDir, "workspace-artifacts.md"),
    renderWorkspaceArtifactDigest(workspaceArtifacts),
  );
  await writeText(
    path.join(artifactsDir, "email-attachments.md"),
    renderAttachmentDigest(attachments),
  );
}

module.exports = { generateBackfill };

if (require.main === module) {
  generateBackfill().catch((error) => {
    process.stderr.write(
      `[lexie-backfill] generation failed: ${error.stack || error.message}\n`,
    );
    process.exit(1);
  });
}
