#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");

const { generateBackfill } = require("./generate-backfill");

const APP_ROOT = process.env.LEXIE_APP_ROOT || "/app";
const DATA_ROOT = process.env.LEXIE_DATA_ROOT || "/data";
const WORKSPACE_ROOT =
  process.env.OPENCLAW_WORKSPACE_DIR || path.join(DATA_ROOT, "workspace");
const STATE_ROOT =
  process.env.OPENCLAW_STATE_DIR || path.join(DATA_ROOT, ".openclaw");

const SOURCE_WORKSPACE = path.join(APP_ROOT, "workspace");
const CONFIG_PATH = path.join(STATE_ROOT, "openclaw.json");
const TARGET_SKILLS_DIR = path.join(WORKSPACE_ROOT, "skills");
const TARGET_KNOWLEDGE_DIR = path.join(WORKSPACE_ROOT, "knowledge");
const ROOT_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "MEMORY.md",
];
const MANAGED_DIRS = ["knowledge", "skills"];

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonSafe(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

async function copyManagedFile(sourcePath, targetPath) {
  const contents = await fs.readFile(sourcePath, "utf8");
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, contents, "utf8");
}

async function copyManagedDir(sourceDir, targetDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  await ensureDir(targetDir);
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyManagedDir(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await copyManagedFile(sourcePath, targetPath);
    }
  }
}

function ensureObject(parent, key) {
  if (!parent[key] || typeof parent[key] !== "object" || Array.isArray(parent[key])) {
    parent[key] = {};
  }
  return parent[key];
}

function appendUnique(array, value) {
  if (!array.includes(value)) {
    array.push(value);
  }
  return array;
}

async function syncWorkspace() {
  for (const fileName of ROOT_FILES) {
    await copyManagedFile(
      path.join(SOURCE_WORKSPACE, fileName),
      path.join(WORKSPACE_ROOT, fileName),
    );
  }

  for (const dirName of MANAGED_DIRS) {
    await copyManagedDir(
      path.join(SOURCE_WORKSPACE, dirName),
      path.join(WORKSPACE_ROOT, dirName),
    );
  }

  const bootstrapPath = path.join(WORKSPACE_ROOT, "BOOTSTRAP.md");
  if (await pathExists(bootstrapPath)) {
    await fs.rm(bootstrapPath, { force: true });
  }
}

async function patchOpenClawConfig() {
  const config = await readJsonSafe(CONFIG_PATH, {});
  const agents = ensureObject(config, "agents");
  const defaults = ensureObject(agents, "defaults");
  const memorySearch = ensureObject(defaults, "memorySearch");
  const experimental = ensureObject(memorySearch, "experimental");
  const remote = ensureObject(memorySearch, "remote");
  const remoteBatch = ensureObject(remote, "batch");
  const store = ensureObject(memorySearch, "store");
  const vectorStore = ensureObject(store, "vector");
  const compaction = ensureObject(defaults, "compaction");
  const memoryFlush = ensureObject(compaction, "memoryFlush");
  const session = ensureObject(config, "session");
  const skills = ensureObject(config, "skills");
  const skillLoad = ensureObject(skills, "load");

  defaults.workspace = WORKSPACE_ROOT;

  memorySearch.enabled = true;
  memorySearch.provider = "openai";
  memorySearch.model = "text-embedding-3-small";
  memorySearch.sources = ["memory", "sessions"];
  experimental.sessionMemory = true;
  vectorStore.enabled = true;
  remoteBatch.enabled = true;
  remoteBatch.wait = true;
  if (typeof remoteBatch.concurrency !== "number") {
    remoteBatch.concurrency = 2;
  }

  memoryFlush.enabled = true;

  session.dmScope = "per-channel-peer";

  if (!Array.isArray(skillLoad.extraDirs)) {
    skillLoad.extraDirs = [];
  }
  appendUnique(skillLoad.extraDirs, TARGET_SKILLS_DIR);
  if (typeof skillLoad.watch !== "boolean") {
    skillLoad.watch = true;
  }

  await ensureDir(path.dirname(CONFIG_PATH));
  await writeJsonAtomic(CONFIG_PATH, config);
}

async function main() {
  await ensureDir(WORKSPACE_ROOT);
  await ensureDir(STATE_ROOT);
  await ensureDir(TARGET_SKILLS_DIR);
  await ensureDir(TARGET_KNOWLEDGE_DIR);

  await syncWorkspace();
  await patchOpenClawConfig();
  await generateBackfill({
    workspaceRoot: WORKSPACE_ROOT,
    stateRoot: STATE_ROOT,
  });

  process.stdout.write(
    `[lexie-bootstrap] workspace synced to ${WORKSPACE_ROOT} and config patched at ${CONFIG_PATH}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `[lexie-bootstrap] bootstrap failed: ${error.stack || error.message}\n`,
  );
  process.exit(1);
});
