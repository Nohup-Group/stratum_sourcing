const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveDefaultModelConfig } = require("./scripts/bootstrap-runtime");

test("resolveDefaultModelConfig prefers Codex when an auth profile exists", () => {
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

  assert.deepEqual(resolveDefaultModelConfig(config), {
    primary: "openai-codex/gpt-5.4",
    fallbacks: ["openai-direct/gpt-5.4"],
  });

  if (previousApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = previousApiKey;
  }
});

test("resolveDefaultModelConfig falls back to openai-direct without Codex auth", () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";

  assert.deepEqual(resolveDefaultModelConfig({}), {
    primary: "openai-direct/gpt-5.4",
    fallbacks: [],
  });

  if (previousApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = previousApiKey;
  }
});
