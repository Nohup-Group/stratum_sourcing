#!/usr/bin/env node
// Daily auto-refresh for the openai-codex OAuth profile.
//
// Reads /data/.openclaw/agents/main/agent/auth-profiles.json. If the
// openai-codex:default profile's access token expires within the threshold
// (default 48h), POSTs to the oauth minter to obtain a fresh token pair,
// writes it atomically with a timestamped backup, and kills the running
// OpenClaw gateway child so the wrapper respawns it and re-reads the file.
//
// Invoked both at wrapper startup (gated by threshold — no-op if healthy) and
// on a daily 03:00 UTC schedule from server.js.
//
// Exit codes: 0 (no-op or success), 1 (mint/write failure).

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { execSync } = require("node:child_process");

const STATE_ROOT = process.env.OPENCLAW_STATE_DIR || "/data/.openclaw";
const AUTH_PROFILES_PATH = path.join(
  STATE_ROOT,
  "agents",
  "main",
  "agent",
  "auth-profiles.json",
);
const MINTER_URL =
  process.env.OAUTH_MINTER_URL ||
  "https://oauthminter-production.up.railway.app/mint";
const MINTER_KEY = process.env.OAUTH_MINTER_API_KEY;
const THRESHOLD_HOURS = Number(
  process.env.CODEX_AUTO_REFRESH_THRESHOLD_HOURS || "48",
);
const THRESHOLD_MS = THRESHOLD_HOURS * 60 * 60 * 1000;
const DRY_RUN = process.env.CODEX_AUTO_REFRESH_DRY_RUN === "1";
const MINT_TIMEOUT_MS = 5 * 60 * 1000;

function log(level, msg, extra) {
  const line = {
    ts: new Date().toISOString(),
    level,
    component: "codex-refresh",
    msg,
    ...(extra || {}),
  };
  console.log(JSON.stringify(line));
}

function mintNewToken() {
  return new Promise((resolve, reject) => {
    const u = new URL(MINTER_URL);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          Authorization: `Bearer ${MINTER_KEY}`,
          "Content-Type": "application/json",
          "Content-Length": 0,
        },
        timeout: MINT_TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return reject(
              new Error(
                `minter_http_${res.statusCode}: ${body.slice(0, 200)}`,
              ),
            );
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`minter_bad_json: ${err.message}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("minter_timeout")));
    req.end();
  });
}

function decodeJwtExpMs(accessToken) {
  const parts = accessToken.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    if (typeof payload.exp === "number") {
      return payload.exp * 1000;
    }
  } catch (_) {
    // fallthrough
  }
  return null;
}

function kickGateway() {
  try {
    execSync("pkill -f 'openclaw.*gateway'", { stdio: "ignore" });
    return true;
  } catch (_) {
    return false;
  }
}

async function main() {
  if (!MINTER_KEY) {
    log("info", "OAUTH_MINTER_API_KEY not set, refresh disabled");
    return 0;
  }

  let store;
  try {
    store = JSON.parse(fs.readFileSync(AUTH_PROFILES_PATH, "utf8"));
  } catch (err) {
    log("warn", "auth-profiles.json unreadable, skipping", {
      error: err.message,
      path: AUTH_PROFILES_PATH,
    });
    return 0;
  }

  const profile =
    store.profiles && store.profiles["openai-codex:default"];
  if (!profile || profile.type !== "oauth") {
    log("info", "no openai-codex:default oauth profile, skipping");
    return 0;
  }

  const expiresMs =
    typeof profile.expires === "number" ? profile.expires : 0;
  const msLeft = expiresMs - Date.now();
  const hoursLeft = Math.round((msLeft / 3600000) * 10) / 10;

  if (msLeft > THRESHOLD_MS) {
    log("info", "codex token healthy, no refresh needed", {
      hoursLeft,
      thresholdHours: THRESHOLD_HOURS,
    });
    return 0;
  }

  log("info", "codex token inside refresh threshold", {
    hoursLeft,
    thresholdHours: THRESHOLD_HOURS,
    dryRun: DRY_RUN,
  });

  if (DRY_RUN) {
    log("info", "dry run, not minting");
    return 0;
  }

  let minted;
  try {
    minted = await mintNewToken();
  } catch (err) {
    log("error", "mint failed", { error: err.message });
    return 1;
  }

  if (!minted.access_token || !minted.refresh_token) {
    log("error", "mint response missing tokens", {
      keys: Object.keys(minted || {}),
    });
    return 1;
  }

  const newExpiresMs =
    decodeJwtExpMs(minted.access_token) ||
    Date.now() + (Number(minted.expires_in) || 86400) * 1000;

  const backupPath = `${AUTH_PROFILES_PATH}.bak.${Date.now()}`;
  try {
    fs.copyFileSync(AUTH_PROFILES_PATH, backupPath);
  } catch (err) {
    log("error", "backup failed, aborting", { error: err.message });
    return 1;
  }

  profile.access = minted.access_token;
  profile.refresh = minted.refresh_token;
  profile.expires = newExpiresMs;

  const tmpPath = `${AUTH_PROFILES_PATH}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2) + "\n", {
      mode: 0o600,
    });
    fs.renameSync(tmpPath, AUTH_PROFILES_PATH);
  } catch (err) {
    log("error", "write failed", { error: err.message });
    return 1;
  }

  const gatewayKicked = kickGateway();

  log("info", "codex token refreshed", {
    newExpires: new Date(newExpiresMs).toISOString(),
    newExpiresHours: Math.round(((newExpiresMs - Date.now()) / 3600000) * 10) / 10,
    backup: backupPath,
    gatewayKicked,
  });
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log("error", "unhandled", { error: err.message });
    process.exit(1);
  });
