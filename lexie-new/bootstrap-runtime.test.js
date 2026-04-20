const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { resolveDefaultModelConfig } = require("./scripts/bootstrap-runtime");

test("resolveDefaultModelConfig prefers Codex when an auth profile exists", async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";

  const config = {
    auth: {
      profiles: {
        "openai-codex:default": {
          provider: "openai-codex",
          mode: "oauth",
        },
      },
    },
  };

  assert.deepEqual(await resolveDefaultModelConfig(config), {
    primary: "openai-codex/gpt-5.4",
    fallbacks: [],
  });

  if (previousApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = previousApiKey;
  }
});

test("resolveDefaultModelConfig reads Codex auth from live agent state", async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENAI_API_KEY = "test-openai-key";

  const tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "lexie-bootstrap-"));
  const authProfilesPath = path.join(tempStateDir, "agents", "main", "agent", "auth-profiles.json");
  await fs.mkdir(path.dirname(authProfilesPath), { recursive: true });
  await fs.writeFile(
    authProfilesPath,
    `${JSON.stringify(
      {
        "openai-codex:default": {
          provider: "openai-codex",
          mode: "oauth",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  process.env.OPENCLAW_STATE_DIR = tempStateDir;

  try {
    assert.deepEqual(await resolveDefaultModelConfig({}), {
      primary: "openai-codex/gpt-5.4",
      fallbacks: [],
    });
  } finally {
    await fs.rm(tempStateDir, { recursive: true, force: true });
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousApiKey;
    }
  }
});

test("resolveDefaultModelConfig falls back to openai-direct without Codex auth", async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";

  assert.deepEqual(await resolveDefaultModelConfig({}), {
    primary: "openai-direct/gpt-5.4",
    fallbacks: [],
  });

  if (previousApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = previousApiKey;
  }
});
