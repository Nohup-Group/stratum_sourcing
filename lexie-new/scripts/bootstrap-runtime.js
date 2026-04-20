#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const { generateBackfill } = require("./generate-backfill");

const APP_ROOT = process.env.LEXIE_APP_ROOT || "/app";
const DATA_ROOT = process.env.LEXIE_DATA_ROOT || "/data";
const WORKSPACE_ROOT =
  process.env.OPENCLAW_WORKSPACE_DIR || path.join(DATA_ROOT, "workspace");
const STATE_ROOT =
  process.env.OPENCLAW_STATE_DIR || path.join(DATA_ROOT, ".openclaw");

const SOURCE_WORKSPACE = path.join(APP_ROOT, "workspace");
const SOURCE_INVESTOR_WORKSPACE = path.join(APP_ROOT, "workspace-investor");
const INVESTOR_WORKSPACE_ROOT = path.join(DATA_ROOT, "workspace-investor");
const CONFIG_PATH = path.join(STATE_ROOT, "openclaw.json");
const BOOTSTRAP_STATE_PATH = path.join(DATA_ROOT, ".lexie-bootstrap-state.json");
const TARGET_SKILLS_DIR = path.join(WORKSPACE_ROOT, "skills");
const TARGET_KNOWLEDGE_DIR = path.join(WORKSPACE_ROOT, "knowledge");
const TARGET_INVESTOR_SKILLS_DIR = path.join(INVESTOR_WORKSPACE_ROOT, "skills");
const TARGET_INVESTOR_KNOWLEDGE_DIR = path.join(INVESTOR_WORKSPACE_ROOT, "knowledge");
const WORKSPACE_SYNC_VERSION = 1;
const BACKFILL_VERSION = 1;
const ROOT_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "MEMORY.md",
];
const SEEDED_DIRS = ["knowledge", "skills"];
const MANAGED_DIRS = [];

function log(message) {
  process.stdout.write(`[lexie-bootstrap] ${message}\n`);
}

function logDuration(label, startedAt) {
  log(`${label} (${Date.now() - startedAt}ms)`);
}

function splitAllowedOrigins(raw) {
  if (typeof raw !== "string") {
    return [];
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function toHttpsOrigin(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return null;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

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

async function copyFileIfMissing(sourcePath, targetPath) {
  if (await pathExists(targetPath)) {
    return;
  }
  await copyManagedFile(sourcePath, targetPath);
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

async function copySeededDir(sourceDir, targetDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  await ensureDir(targetDir);
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copySeededDir(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await copyFileIfMissing(sourcePath, targetPath);
    }
  }
}

async function replaceManagedDir(sourceDir, targetDir) {
  await fs.rm(targetDir, { recursive: true, force: true });
  await copyManagedDir(sourceDir, targetDir);
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

function ensureGatewayToken(currentValue) {
  const envCandidates = [
    process.env.OPENCLAW_GATEWAY_REMOTE_TOKEN,
    process.env.OPENCLAW_GATEWAY_TOKEN,
  ];
  for (const candidate of envCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  if (typeof currentValue === "string" && currentValue.trim()) {
    return currentValue.trim();
  }
  return crypto.randomBytes(24).toString("hex");
}

async function readBootstrapState() {
  return await readJsonSafe(BOOTSTRAP_STATE_PATH, {});
}

async function writeBootstrapState(state) {
  await writeJsonAtomic(BOOTSTRAP_STATE_PATH, state);
}

function getMainAuthProfilesPath() {
  const stateRoot = process.env.OPENCLAW_STATE_DIR || STATE_ROOT;
  return path.join(stateRoot, "agents", "main", "agent", "auth-profiles.json");
}

function profilesContainCodex(profiles) {
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    return false;
  }

  return Object.entries(profiles).some(([name, profile]) => {
    return (
      typeof name === "string" &&
      name.startsWith("openai-codex:") &&
      profile &&
      typeof profile === "object" &&
      profile.provider === "openai-codex"
    );
  });
}

async function hasCodexProfile(config) {
  const auth = config && typeof config === "object" ? config.auth : null;
  const profiles = auth && typeof auth === "object" ? auth.profiles : null;
  if (profilesContainCodex(profiles)) {
    return true;
  }

  const authProfiles = await readJsonSafe(getMainAuthProfilesPath(), null);
  if (!authProfiles || typeof authProfiles !== "object") {
    return false;
  }

  return (
    profilesContainCodex(authProfiles.profiles) ||
    profilesContainCodex(authProfiles)
  );
}

async function resolveDefaultModelConfig(config) {
  const openAiKeyConfigured = Boolean(
    typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.trim(),
  );
  const codexConfigured = await hasCodexProfile(config);

  if (codexConfigured) {
    return {
      primary: "openai-codex/gpt-5.4",
      fallbacks: [],
    };
  }

  if (openAiKeyConfigured) {
    return {
      primary: "openai-direct/gpt-5.4",
      fallbacks: [],
    };
  }

  return null;
}

async function shouldGenerateBackfill(state) {
  if (state.backfillVersion !== BACKFILL_VERSION) {
    return true;
  }

  return !(await pathExists(
    path.join(WORKSPACE_ROOT, "knowledge", "backfill", "manifests", "session-inventory.md"),
  ));
}

async function syncWorkspace() {
  const startedAt = Date.now();
  log(`syncWorkspace start source=${SOURCE_WORKSPACE} target=${WORKSPACE_ROOT}`);
  for (const fileName of ROOT_FILES) {
    await copyFileIfMissing(
      path.join(SOURCE_WORKSPACE, fileName),
      path.join(WORKSPACE_ROOT, fileName),
    );
  }

  for (const dirName of SEEDED_DIRS) {
    await copySeededDir(
      path.join(SOURCE_WORKSPACE, dirName),
      path.join(WORKSPACE_ROOT, dirName),
    );
  }

  for (const dirName of MANAGED_DIRS) {
    await replaceManagedDir(
      path.join(SOURCE_WORKSPACE, dirName),
      path.join(WORKSPACE_ROOT, dirName),
    );
  }

  const bootstrapPath = path.join(WORKSPACE_ROOT, "BOOTSTRAP.md");
  if (await pathExists(bootstrapPath)) {
    await fs.rm(bootstrapPath, { force: true });
  }
  logDuration("syncWorkspace complete", startedAt);
}

const INVESTOR_ROOT_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "TOOLS.md",
  "MEMORY.md",
];
const INVESTOR_SEEDED_DIRS = ["knowledge", "skills"];
const INVESTOR_MANAGED_DIRS = [];

async function syncInvestorWorkspace() {
  const startedAt = Date.now();
  log(`syncInvestorWorkspace start source=${SOURCE_INVESTOR_WORKSPACE} target=${INVESTOR_WORKSPACE_ROOT}`);
  if (!(await pathExists(SOURCE_INVESTOR_WORKSPACE))) {
    log("syncInvestorWorkspace skipped (source workspace missing)");
    return;
  }

  for (const fileName of INVESTOR_ROOT_FILES) {
    const src = path.join(SOURCE_INVESTOR_WORKSPACE, fileName);
    if (await pathExists(src)) {
      await copyFileIfMissing(src, path.join(INVESTOR_WORKSPACE_ROOT, fileName));
    }
  }

  for (const dirName of INVESTOR_SEEDED_DIRS) {
    const src = path.join(SOURCE_INVESTOR_WORKSPACE, dirName);
    if (await pathExists(src)) {
      await copySeededDir(src, path.join(INVESTOR_WORKSPACE_ROOT, dirName));
    }
  }

  for (const dirName of INVESTOR_MANAGED_DIRS) {
    const src = path.join(SOURCE_INVESTOR_WORKSPACE, dirName);
    if (await pathExists(src)) {
      await replaceManagedDir(src, path.join(INVESTOR_WORKSPACE_ROOT, dirName));
    }
  }
  logDuration("syncInvestorWorkspace complete", startedAt);
}

async function patchOpenClawConfig() {
  const startedAt = Date.now();
  log(`patchOpenClawConfig start path=${CONFIG_PATH}`);
  const config = await readJsonSafe(CONFIG_PATH, {});
  const agents = ensureObject(config, "agents");
  const defaults = ensureObject(agents, "defaults");
  const gateway = ensureObject(config, "gateway");
  const gatewayAuth = ensureObject(gateway, "auth");
  const gatewayTrustedProxy = ensureObject(gatewayAuth, "trustedProxy");
  const gatewayControlUi = ensureObject(gateway, "controlUi");
  const gatewayRemote = ensureObject(gateway, "remote");
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
  const configuredOrigins = new Set(
    Array.isArray(gatewayControlUi.allowedOrigins)
      ? gatewayControlUi.allowedOrigins.filter((value) => typeof value === "string")
      : [],
  );

  defaults.workspace = WORKSPACE_ROOT;
  defaults.thinkingDefault = "high";

  // Clean up stale key from prior broken deploy
  delete agents.investor;

  // --- Multi-agent: main (internal) + investor (restricted workspace) ---
  if (!Array.isArray(agents.list)) {
    agents.list = [];
  }
  function upsertAgent(list, entry) {
    const idx = list.findIndex((a) => a.id === entry.id);
    if (idx >= 0) {
      Object.assign(list[idx], entry);
    } else {
      list.push(entry);
    }
  }
  upsertAgent(agents.list, {
    id: "main",
    default: true,
    name: "Lexie",
    workspace: WORKSPACE_ROOT,
  });
  upsertAgent(agents.list, {
    id: "investor",
    name: "Lexie Investor",
    workspace: INVESTOR_WORKSPACE_ROOT,
    agentDir: path.join(STATE_ROOT, "agents", "investor", "agent"),
  });

  // --- Models: prefer Codex OAuth from live agent state; only use direct if Codex auth is absent ---
  const models = ensureObject(config, "models");
  const providers = ensureObject(models, "providers");
  const openaiDirect = ensureObject(providers, "openai-direct");
  openaiDirect.baseUrl = "https://api.openai.com/v1";
  openaiDirect.apiKey = "${OPENAI_API_KEY}";
  openaiDirect.api = "openai-responses";
  openaiDirect.models = [
    {
      id: "gpt-5.4",
      name: "gpt-5.4",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1048576,
      maxTokens: 32000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      api: "openai-responses",
    },
  ];

  const defaultModel = ensureObject(defaults, "model");
  const resolvedModelConfig = await resolveDefaultModelConfig(config);
  if (resolvedModelConfig) {
    defaultModel.primary = resolvedModelConfig.primary;
    defaultModel.fallbacks = resolvedModelConfig.fallbacks;
  }

  memorySearch.enabled = true;
  memorySearch.provider = "openai";
  memorySearch.model = "text-embedding-3-small";
  memorySearch.sources = ["memory", "sessions"];
  experimental.sessionMemory = true;
  // Remove stale local embedding fallback so Railway stays purely on OpenAI.
  delete memorySearch.local;
  vectorStore.enabled = true;
  remoteBatch.enabled = true;
  remoteBatch.wait = true;
  if (typeof remoteBatch.concurrency !== "number") {
    remoteBatch.concurrency = 2;
  }

  memoryFlush.enabled = true;

  session.dmScope = "per-channel-peer";

  const stableGatewayToken = ensureGatewayToken(gatewayAuth.token || gatewayRemote.token);
  // OpenClaw 2026.4.x hardened trusted-proxy: it rejects loopback-sourced
  // requests (reason=trusted_proxy_loopback_source), which is exactly our
  // topology (wrapper and gateway in the same container, wrapper connects
  // via 127.0.0.1). Same-host reverse-proxy setups are intended to use
  // mode=token: the wrapper validates user identity (Cloudflare Access +
  // OPENCLAW_CONTROL_UI_PROXY_TOKEN) before proxying, then carries a shared
  // gateway.auth.token into the WebSocket connect message so the gateway
  // accepts the call with operator scopes.
  gatewayAuth.mode = "token";
  gatewayAuth.token = stableGatewayToken;
  delete gatewayAuth.password;
  delete gatewayAuth.trustedProxy;
  if (gateway.auth && gateway.auth.trustedProxy) {
    delete gateway.auth.trustedProxy;
  }
  gatewayRemote.token = stableGatewayToken;
  gatewayControlUi.basePath =
    process.env.OPENCLAW_CONTROL_UI_BASE_PATH || "/openclaw/ui";
  gatewayControlUi.dangerouslyDisableDeviceAuth = true;

  for (const origin of splitAllowedOrigins(process.env.OPENCLAW_ALLOWED_ORIGINS)) {
    configuredOrigins.add(origin);
  }
  for (const origin of [
    process.env.RAILWAY_PUBLIC_DOMAIN,
    process.env.RAILWAY_SERVICE_LEXIE_NEW_FRONTEND_URL,
    process.env.LEXIE_FRONTEND_PUBLIC_DOMAIN || "lexie.stratum3.org",
  ]) {
    const normalizedOrigin = toHttpsOrigin(origin);
    if (normalizedOrigin) {
      configuredOrigins.add(normalizedOrigin);
    }
  }
  gatewayControlUi.allowedOrigins = Array.from(configuredOrigins);

  if (!Array.isArray(gateway.trustedProxies)) {
    gateway.trustedProxies = [];
  }
  appendUnique(gateway.trustedProxies, "127.0.0.1");
  appendUnique(gateway.trustedProxies, "::1");

  if (!Array.isArray(skillLoad.extraDirs)) {
    skillLoad.extraDirs = [];
  }
  appendUnique(skillLoad.extraDirs, TARGET_SKILLS_DIR);
  if (typeof skillLoad.watch !== "boolean") {
    skillLoad.watch = true;
  }

  await ensureDir(path.dirname(CONFIG_PATH));
  await writeJsonAtomic(CONFIG_PATH, config);
  log(
    `patchOpenClawConfig complete model=${defaultModel.primary || "unset"} thinking=${defaults.thinkingDefault || "unset"} gatewayAuthMode=${gatewayAuth.mode || "unset"} agents=${Array.isArray(agents.list) ? agents.list.map((agent) => agent.id).join(",") : "none"}`,
  );
  logDuration("patchOpenClawConfig duration", startedAt);
}

async function main() {
  const startedAt = Date.now();
  log(
    `bootstrap start app_root=${APP_ROOT} data_root=${DATA_ROOT} workspace_root=${WORKSPACE_ROOT} investor_workspace_root=${INVESTOR_WORKSPACE_ROOT} state_root=${STATE_ROOT}`,
  );
  const bootstrapState = await readBootstrapState();
  log(
    `bootstrap state workspaceSyncVersion=${bootstrapState.workspaceSyncVersion || 0} backfillVersion=${bootstrapState.backfillVersion || 0} updatedAt=${bootstrapState.updatedAt || "never"}`,
  );

  await ensureDir(WORKSPACE_ROOT);
  await ensureDir(INVESTOR_WORKSPACE_ROOT);
  await ensureDir(STATE_ROOT);
  await ensureDir(TARGET_SKILLS_DIR);
  await ensureDir(TARGET_KNOWLEDGE_DIR);
  await ensureDir(TARGET_INVESTOR_SKILLS_DIR);
  await ensureDir(TARGET_INVESTOR_KNOWLEDGE_DIR);
  await ensureDir(path.join(STATE_ROOT, "agents", "investor", "agent"));

  await syncWorkspace();
  await syncInvestorWorkspace();
  await patchOpenClawConfig();
  if (await shouldGenerateBackfill(bootstrapState)) {
    const backfillStartedAt = Date.now();
    log("generateBackfill start");
    await generateBackfill({
      workspaceRoot: WORKSPACE_ROOT,
      stateRoot: STATE_ROOT,
    });
    logDuration("generateBackfill complete", backfillStartedAt);
  } else {
    log("generateBackfill skipped (state up to date)");
  }
  await writeBootstrapState({
    ...bootstrapState,
    workspaceSyncVersion: WORKSPACE_SYNC_VERSION,
    backfillVersion: BACKFILL_VERSION,
    updatedAt: new Date().toISOString(),
  });

  log(`workspace synced to ${WORKSPACE_ROOT} and config patched at ${CONFIG_PATH}`);
  logDuration("bootstrap finished", startedAt);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `[lexie-bootstrap] bootstrap failed: ${error.stack || error.message}\n`,
    );
    process.exit(1);
  });
}

module.exports = {
  BACKFILL_VERSION,
  WORKSPACE_SYNC_VERSION,
  hasCodexProfile,
  resolveDefaultModelConfig,
  shouldGenerateBackfill,
};
