const crypto = require("crypto");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");
const { Pool } = require("pg");
const { createPgPoolConfig } = require("./pg-config");
const {
  INTERNAL_EMAIL_DOMAIN,
  resolveTrustedInternalUser,
} = require("./request-auth");
const { runOpsPrompt } = require("./ops-gateway");
const {
  DEFAULT_AGENT_ID,
  DEFAULT_SESSION_NAME,
  SESSION_STATUS,
  createSession,
  deleteSession,
  detectWebSearchProvider,
  ensureChatSessionsTable,
  listSessions,
  normalizeClientId,
  normalizeSessionStatus,
  touchSession,
  updateSession,
} = require("./session-store");
const {
  ensureAuthTables,
  createInvite,
  listInvites,
  revokeInvite,
  redeemInvite,
  verifySession,
  getInvestorJwt,
  setInvestorCookie,
  clearInvestorCookie,
} = require("./auth");

const PORT = parseInteger(process.env.PORT, 8080);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST || "127.0.0.1";
const INTERNAL_GATEWAY_PORT = parseInteger(
  process.env.INTERNAL_GATEWAY_PORT || process.env.OPENCLAW_INTERNAL_PORT,
  18789,
);
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || "/data";
const OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/data/.openclaw";
const OPENCLAW_WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace";
const OPENCLAW_AGENT_ID = process.env.OPENCLAW_AGENT_ID || DEFAULT_AGENT_ID;
const INVESTOR_AGENT_ID = "investor";
const DATABASE_URL = process.env.DATABASE_URL || "";
const LEXIE_OPS_TOKEN = process.env.LEXIE_OPS_TOKEN || "";
const OPENCLAW_CONTROL_UI_BASE_PATH = normalizeBasePath(
  process.env.OPENCLAW_CONTROL_UI_BASE_PATH || "/openclaw/ui",
);
const OPENCLAW_CONTROL_UI_LAUNCH_PATH = normalizeBasePath(
  process.env.OPENCLAW_CONTROL_UI_LAUNCH_PATH || "/openclaw",
);
const OPENCLAW_CONTROL_UI_LOGIN_PATH = `${OPENCLAW_CONTROL_UI_LAUNCH_PATH}/login`;
const OPENCLAW_CONTROL_UI_LOGOUT_PATH = `${OPENCLAW_CONTROL_UI_LAUNCH_PATH}/logout`;
const OPENCLAW_CONTROL_UI_COOKIE_NAME =
  process.env.OPENCLAW_CONTROL_UI_COOKIE_NAME || "lexie_openclaw_ui";
const OPENCLAW_CONTROL_UI_USER =
  process.env.OPENCLAW_CONTROL_UI_USER || "superadmin@lexie.local";
const OPENCLAW_CONTROL_UI_PROXY_TOKEN =
  process.env.OPENCLAW_CONTROL_UI_PROXY_TOKEN || "";
const OPENCLAW_GATEWAY_REMOTE_TOKEN =
  process.env.OPENCLAW_GATEWAY_REMOTE_TOKEN ||
  process.env.OPENCLAW_GATEWAY_TOKEN ||
  "";
const OPENCLAW_CONTROL_UI_COOKIE_TTL_MS = parseInteger(
  process.env.OPENCLAW_CONTROL_UI_COOKIE_TTL_MS || "604800000",
  604800000,
);
const LISTEN_HOST = process.env.LISTEN_HOST || "0.0.0.0";
const GATEWAY_STOP_TIMEOUT_MS = parseInteger(
  process.env.GATEWAY_STOP_TIMEOUT_MS || "15000",
  15000,
);

let shuttingDown = false;
let gatewayProcess = null;
let gatewayReady = false;
let restartTimer = null;
let sessionStoreReady = false;
let sessionStoreError = DATABASE_URL
  ? null
  : new Error("DATABASE_URL is required for the session API");
let shutdownPromise = null;

const pool = DATABASE_URL ? new Pool(createPgPoolConfig(DATABASE_URL)) : null;

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeBasePath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  return `/${trimmed.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function log(message) {
  process.stdout.write(`[lexie-new] ${message}\n`);
}

function logError(message) {
  process.stderr.write(`[lexie-new] ${message}\n`);
}

function pathMatches(pathname, basePath) {
  if (basePath === "/") {
    return pathname === "/";
  }
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (typeof cookieHeader !== "string") {
    return cookies;
  }
  for (const pair of cookieHeader.split(";")) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }
    const key = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    cookies[key] = value;
  }
  return cookies;
}

function resolveControlUiPassword() {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return "";
  }
  const direct = process.env.OPENCLAW_CONTROL_UI_PASSWORD || "";
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  return "";
}

function resolveControlUiCookieSecret(password) {
  const explicit = process.env.OPENCLAW_CONTROL_UI_COOKIE_SECRET;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  return password;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function createSignedControlUiSession(secret, user) {
  const payload = {
    user,
    exp: Date.now() + OPENCLAW_CONTROL_UI_COOKIE_TTL_MS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function verifySignedControlUiSession(secret, token) {
  if (!secret || typeof token !== "string") {
    return null;
  }
  const separatorIndex = token.lastIndexOf(".");
  if (separatorIndex <= 0) {
    return null;
  }
  const encodedPayload = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  const expected = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
  if (signature !== expected) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );
    if (!payload || typeof payload !== "object" || typeof payload.user !== "string") {
      return null;
    }
    if (typeof payload.exp !== "number" || payload.exp <= Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function setControlUiCookie(response, value, maxAgeSeconds) {
  response.setHeader(
    "Set-Cookie",
    `${OPENCLAW_CONTROL_UI_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=${OPENCLAW_CONTROL_UI_LAUNCH_PATH}; Max-Age=${maxAgeSeconds}`,
  );
}

function clearControlUiCookie(response) {
  response.setHeader(
    "Set-Cookie",
    `${OPENCLAW_CONTROL_UI_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=${OPENCLAW_CONTROL_UI_LAUNCH_PATH}; Max-Age=0`,
  );
}

function readControlUiSession(request) {
  const password = resolveControlUiPassword();
  const secret = resolveControlUiCookieSecret(password);
  if (!password || !secret) {
    return null;
  }
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[OPENCLAW_CONTROL_UI_COOKIE_NAME];
  return verifySignedControlUiSession(secret, token);
}

function resolveInternalStaffUser(request) {
  return resolveTrustedInternalUser(request, {
    proxyToken: OPENCLAW_CONTROL_UI_PROXY_TOKEN,
    allowedEmailDomain: INTERNAL_EMAIL_DOMAIN,
  });
}

function resolveControlUiOperator(request) {
  const internalUser = resolveInternalStaffUser(request);
  if (internalUser) {
    return { user: internalUser, source: "trusted-proxy" };
  }
  const session = readControlUiSession(request);
  if (session) {
    return { user: session.user, source: "cookie" };
  }
  return null;
}

function resolveApiActor(request, investor) {
  if (investor) {
    return {
      kind: "investor",
      clientId: investorClientId(investor.inviteId),
      investor,
    };
  }

  const internalUser = resolveInternalStaffUser(request);
  if (!internalUser) {
    return null;
  }

  return {
    kind: "internal",
    email: internalUser,
    clientId: resolveClientId(request),
  };
}

function sendNotFound(response) {
  response.writeHead(404, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end("Not found");
}

function redirect(response, location, statusCode = 307) {
  response.writeHead(statusCode, {
    location,
    "cache-control": "no-store",
  });
  response.end();
}

function renderControlUiLoginPage(response, { errorMessage = "" } = {}) {
  const escapedError = errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : "";
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Lexie Control UI</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0e1117;
        color: #f5f7fb;
        font: 16px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      form {
        width: min(420px, calc(100vw - 32px));
        padding: 28px;
        border-radius: 18px;
        background: rgba(20, 25, 34, 0.96);
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
      }
      h1 { margin: 0 0 8px; font-size: 28px; }
      p { margin: 0 0 18px; color: #c6cfdb; }
      label { display: block; margin-bottom: 8px; font-weight: 600; }
      input {
        width: 100%;
        box-sizing: border-box;
        padding: 12px 14px;
        border-radius: 12px;
        border: 1px solid #334155;
        background: #0f172a;
        color: inherit;
        margin-bottom: 14px;
      }
      button {
        width: 100%;
        padding: 12px 14px;
        border: 0;
        border-radius: 12px;
        background: #ff6161;
        color: white;
        font: inherit;
        cursor: pointer;
      }
      .error { color: #ff9c9c; margin-bottom: 14px; }
    </style>
  </head>
  <body>
    <form method="post" action="${OPENCLAW_CONTROL_UI_LOGIN_PATH}">
      <h1>Lexie Control UI</h1>
      <p>Enter the control password to open the proxied OpenClaw UI.</p>
      ${escapedError}
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <button type="submit">Open Control UI</button>
    </form>
  </body>
</html>`;
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

async function ensureSessionStore() {
  if (!pool) {
    sessionStoreReady = false;
    return;
  }

  try {
    await ensureChatSessionsTable(pool);
    await ensureAuthTables(pool);
    sessionStoreReady = true;
    sessionStoreError = null;
    log("session store ready");
  } catch (error) {
    sessionStoreReady = false;
    sessionStoreError = error;
    logError(`session store bootstrap failed: ${error.stack || error.message}`);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createGatewayEnv() {
  const { OPENCLAW_GATEWAY_TOKEN: _ignoredGatewayToken, ...gatewayEnv } = process.env;
  return {
    ...gatewayEnv,
    HOME: OPENCLAW_HOME,
    OPENCLAW_HOME,
    OPENCLAW_STATE_DIR,
    OPENCLAW_WORKSPACE_DIR,
  };
}

function runOpenClawCommand(args, { timeoutMs = GATEWAY_STOP_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("openclaw", args, {
      env: createGatewayEnv(),
      stdio: "inherit",
    });

    let settled = false;
    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    const timeout = setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      finish(() => {
        reject(
          new Error(
            `openclaw ${args.join(" ")} timed out after ${timeoutMs}ms`,
          ),
        );
      });
    }, timeoutMs);

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.on("exit", (code, signal) => {
      finish(() => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `openclaw ${args.join(" ")} exited with code=${code} signal=${signal}`,
          ),
        );
      });
    });
  });
}

async function stopGateway(reason, { tolerateFailure = false } = {}) {
  log(`stopping openclaw gateway (${reason})`);
  try {
    await runOpenClawCommand(["gateway", "stop"]);
  } catch (error) {
    if (!tolerateFailure) {
      throw error;
    }
    logError(
      `best-effort gateway stop failed (${reason}): ${error.stack || error.message}`,
    );
  }
}

async function probeGateway(timeoutMs = 60000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const request = http.request(
        {
          host: INTERNAL_GATEWAY_HOST,
          port: INTERNAL_GATEWAY_PORT,
          method: "GET",
          path: "/",
          timeout: 2000,
        },
        (response) => {
          response.resume();
          resolve(true);
        },
      );

      request.on("timeout", () => {
        request.destroy();
        resolve(false);
      });
      request.on("error", () => resolve(false));
      request.end();
    });

    if (ready) {
      return true;
    }

    await wait(500);
  }

  return false;
}

async function startGateway() {
  if (shuttingDown || gatewayProcess) {
    return;
  }

  gatewayReady = false;
  await stopGateway("pre-start cleanup", { tolerateFailure: true });

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--allow-unconfigured",
  ];

  log(
    `starting openclaw gateway on ${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`,
  );
  gatewayProcess = spawn("openclaw", args, {
    env: createGatewayEnv(),
    stdio: "inherit",
  });

  gatewayProcess.on("exit", (code, signal) => {
    logError(`gateway exited with code=${code} signal=${signal}`);
    gatewayProcess = null;

    if (!shuttingDown) {
      if (restartTimer) {
        clearTimeout(restartTimer);
      }
      restartTimer = setTimeout(async () => {
        restartTimer = null;
        try {
          const stillReachable = await probeGateway(3000);
          if (stillReachable) {
            gatewayReady = true;
            log("gateway launcher exited but gateway is still reachable");
            return;
          }

          gatewayReady = false;
          startGateway().catch((error) => {
            logError(`gateway restart failed: ${error.stack || error.message}`);
          });
        } catch (error) {
          gatewayReady = false;
          logError(`gateway post-exit probe failed: ${error.stack || error.message}`);
          startGateway().catch((restartError) => {
            logError(`gateway restart failed: ${restartError.stack || restartError.message}`);
          });
        }
      }, 1000);
      return;
    }

    gatewayReady = false;
  });

  const ready = await probeGateway();
  gatewayReady = ready;
  if (ready) {
    log("gateway ready");
  } else {
    logError("gateway did not become ready before timeout");
  }
}

function proxyHttpRequest(clientRequest, clientResponse) {
  if (!gatewayReady) {
    clientResponse.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    clientResponse.end("Gateway not ready");
    return;
  }

  const forwardedHeaders = { ...clientRequest.headers };
  forwardedHeaders.host = `${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;
  forwardedHeaders["x-forwarded-for"] = clientRequest.socket.remoteAddress || "";
  forwardedHeaders["x-forwarded-host"] = clientRequest.headers.host || "";
  forwardedHeaders["x-forwarded-proto"] = "https";
  const forwardedUser = resolveForwardedUser(clientRequest);
  if (forwardedUser) {
    forwardedHeaders["x-forwarded-user"] = forwardedUser;
  }

  const upstreamRequest = http.request(
    {
      host: INTERNAL_GATEWAY_HOST,
      port: INTERNAL_GATEWAY_PORT,
      method: clientRequest.method,
      path: clientRequest.url,
      headers: forwardedHeaders,
    },
    (upstreamResponse) => {
      clientResponse.writeHead(
        upstreamResponse.statusCode || 502,
        upstreamResponse.headers,
      );
      upstreamResponse.pipe(clientResponse);
    },
  );

  upstreamRequest.on("error", (error) => {
    logError(`http proxy failed: ${error.message}`);
    if (!clientResponse.headersSent) {
      clientResponse.writeHead(502, {
        "content-type": "text/plain; charset=utf-8",
      });
    }
    clientResponse.end("Gateway unavailable");
  });

  clientRequest.pipe(upstreamRequest);
}

function proxyUpgradeRequest(request, socket, head) {
  if (!gatewayReady) {
    socket.write(
      "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\nGateway not ready",
    );
    socket.destroy();
    return;
  }

  const requestUrl = new URL(request.url, "http://127.0.0.1");
  const isControlUiUpgrade = pathMatches(
    requestUrl.pathname,
    OPENCLAW_CONTROL_UI_BASE_PATH,
  );
  if (isControlUiUpgrade) {
    const operator = resolveControlUiOperator(request);
    if (!operator) {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nCache-Control: no-store\r\n\r\nControl UI login required",
      );
      socket.destroy();
      return;
    }
    request._controlUiUser = operator.user;
  }

  // Resolve user: control UI operator first, then investor session, then trusted internal user.
  let forwardedUser = null;
  if (request._controlUiUser) {
    forwardedUser = request._controlUiUser;
  }
  const investorJwt = getInvestorJwt(request);
  if (!forwardedUser && investorJwt) {
    // Synchronous JWT verify (no DB check) for WebSocket upgrade hot path
    const { verifyJwt } = require("./auth");
    const payload = verifyJwt(investorJwt);
    if (payload && payload.sub) {
      forwardedUser = investorClientId(payload.sub);
    }
  }
  if (!forwardedUser) {
    const internalUser = resolveInternalStaffUser(request);
    const clientId = normalizeClientId(requestUrl.searchParams.get("client_id"));
    if (!internalUser || !clientId) {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nCache-Control: no-store\r\n\r\nAuthentication required",
      );
      socket.destroy();
      return;
    }
    request._internalUserEmail = internalUser;
    forwardedUser = clientId;
  }
  requestUrl.searchParams.delete("client_id");
  const upstreamPath = `${requestUrl.pathname}${requestUrl.search}`;

  const upstream = net.connect(INTERNAL_GATEWAY_PORT, INTERNAL_GATEWAY_HOST, () => {
    let rawRequest = `${request.method} ${upstreamPath} HTTP/${request.httpVersion}\r\n`;
    const filteredHeaders = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const headerName = request.rawHeaders[index];
      const headerValue = request.rawHeaders[index + 1];
      const normalized = headerName.toLowerCase();
      if (
        normalized === "host" ||
        normalized === "forwarded" ||
        normalized === "x-forwarded-for" ||
        normalized === "x-forwarded-host" ||
        normalized === "x-forwarded-proto" ||
        normalized === "x-real-ip" ||
        normalized === "cf-connecting-ip"
      ) {
        continue;
      }
      filteredHeaders.push([headerName, headerValue]);
    }

    filteredHeaders.push(["Host", request.headers.host || `${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`]);
    filteredHeaders.push(["X-Forwarded-For", clientAddress(request)]);
    filteredHeaders.push(["X-Forwarded-Host", request.headers.host || ""]);
    filteredHeaders.push(["X-Forwarded-Proto", "https"]);
    if (forwardedUser) {
      filteredHeaders.push(["X-Forwarded-User", forwardedUser]);
    }
    for (const [headerName, headerValue] of filteredHeaders) {
      rawRequest += `${headerName}: ${headerValue}\r\n`;
    }
    rawRequest += "\r\n";

    upstream.write(rawRequest);
    if (head.length > 0) {
      upstream.write(head);
    }

    socket.pipe(upstream).pipe(socket);
  });

  upstream.on("error", (error) => {
    logError(`websocket proxy failed: ${error.message}`);
    socket.destroy();
  });

  socket.on("error", () => {
    upstream.destroy();
  });
}

function clientAddress(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0];
  }
  return request.socket.remoteAddress || "";
}

function resolveForwardedUser(request) {
  if (request._controlUiUser) {
    return request._controlUiUser;
  }
  // Investor cookie-derived client ID is set by the auth middleware.
  if (request._investorClientId) {
    return request._investorClientId;
  }
  return resolveInternalStaffUser(request) || "";
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function sendApiError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

function verifyOpsToken(request) {
  if (!LEXIE_OPS_TOKEN) {
    return { ok: false, statusCode: 503, message: "LEXIE_OPS_TOKEN is not configured" };
  }

  const header = request.headers.authorization || "";
  const expected = `Bearer ${LEXIE_OPS_TOKEN}`;
  if (header !== expected) {
    return { ok: false, statusCode: 403, message: "Invalid ops token" };
  }

  return { ok: true };
}

async function readJsonBody(request) {
  const chunks = [];
  let totalLength = 0;

  for await (const chunk of request) {
    totalLength += chunk.length;
    if (totalLength > 1024 * 1024) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

async function readFormBody(request) {
  const body = await readJsonBodyLikeRaw(request);
  return new URLSearchParams(body);
}

async function readJsonBodyLikeRaw(request) {
  const chunks = [];
  let totalLength = 0;

  for await (const chunk of request) {
    totalLength += chunk.length;
    if (totalLength > 1024 * 1024) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function resolveClientId(request) {
  return normalizeClientId(request.headers["x-lexie-client-id"]);
}

function investorClientId(inviteId) {
  return `investor_${inviteId.replace(/-/g, "").slice(0, 16)}`;
}

async function resolveInvestor(request) {
  if (!pool || !sessionStoreReady) {
    return null;
  }
  const jwt = getInvestorJwt(request);
  if (!jwt) {
    return null;
  }
  return verifySession(pool, jwt);
}

async function getSessionPool(response) {
  if (!pool) {
    sendApiError(response, 500, "DATABASE_URL is not configured");
    return null;
  }

  if (!sessionStoreReady) {
    await ensureSessionStore();
  }

  if (!sessionStoreReady) {
    sendApiError(
      response,
      503,
      sessionStoreError?.message || "Session store is not ready",
    );
    return null;
  }

  return pool;
}

async function handleControlUiRequest(request, response) {
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  const password = resolveControlUiPassword();
  const operator = resolveControlUiOperator(request);
  const directLoginEnabled = Boolean(password);

  if (!directLoginEnabled && !operator && pathMatches(requestUrl.pathname, OPENCLAW_CONTROL_UI_LAUNCH_PATH)) {
    sendNotFound(response);
    return true;
  }

  if (
    requestUrl.pathname === OPENCLAW_CONTROL_UI_LAUNCH_PATH ||
    requestUrl.pathname === `${OPENCLAW_CONTROL_UI_LAUNCH_PATH}/`
  ) {
    if (operator) {
      request._controlUiUser = operator.user;
      redirect(response, OPENCLAW_CONTROL_UI_BASE_PATH);
      return true;
    }
    if (!directLoginEnabled) {
      sendNotFound(response);
      return true;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      renderControlUiLoginPage(response);
      return true;
    }
    sendApiError(response, 405, "Method not allowed");
    return true;
  }

  if (requestUrl.pathname === OPENCLAW_CONTROL_UI_LOGIN_PATH) {
    if (!directLoginEnabled) {
      sendNotFound(response);
      return true;
    }
    if (request.method !== "POST") {
      sendApiError(response, 405, "Method not allowed");
      return true;
    }
    const rawBody = await readJsonBodyLikeRaw(request);
    const form = new URLSearchParams(rawBody);
    const submittedPassword = (form.get("password") || "").trim();
    if (submittedPassword !== password) {
      renderControlUiLoginPage(response, { errorMessage: "Incorrect password." });
      return true;
    }
    const secret = resolveControlUiCookieSecret(password);
    const token = createSignedControlUiSession(secret, OPENCLAW_CONTROL_UI_USER);
    setControlUiCookie(
      response,
      token,
      Math.floor(OPENCLAW_CONTROL_UI_COOKIE_TTL_MS / 1000),
    );
    redirect(response, OPENCLAW_CONTROL_UI_BASE_PATH);
    return true;
  }

  if (requestUrl.pathname === OPENCLAW_CONTROL_UI_LOGOUT_PATH) {
    if (!directLoginEnabled) {
      sendNotFound(response);
      return true;
    }
    clearControlUiCookie(response);
    redirect(response, OPENCLAW_CONTROL_UI_LAUNCH_PATH, 303);
    return true;
  }

  if (pathMatches(requestUrl.pathname, OPENCLAW_CONTROL_UI_BASE_PATH)) {
    if (!operator) {
      if (!directLoginEnabled) {
        sendNotFound(response);
        return true;
      }
      redirect(response, OPENCLAW_CONTROL_UI_LAUNCH_PATH);
      return true;
    }
    request._controlUiUser = operator.user;
    return false;
  }

  if (requestUrl.pathname === "/api/openclaw/control-ui/authorize") {
    if (!operator) {
      if (!directLoginEnabled) {
        sendNotFound(response);
        return true;
      }
      sendApiError(response, 401, "Control UI login required");
      return true;
    }
    request._controlUiUser = operator.user;
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return true;
  }

  if (requestUrl.pathname === "/api/openclaw/control-ui/launch") {
    if (!operator) {
      if (!directLoginEnabled) {
        sendNotFound(response);
        return true;
      }
      redirect(response, OPENCLAW_CONTROL_UI_LAUNCH_PATH);
      return true;
    }
    request._controlUiUser = operator.user;
    redirect(response, OPENCLAW_CONTROL_UI_BASE_PATH);
    return true;
  }

  return false;
}

function buildChatCapabilities() {
  const webSearchProvider = detectWebSearchProvider(process.env);
  const webSearchAvailable = Boolean(webSearchProvider);

  return {
    gatewayReady,
    gatewayReason: gatewayReady ? null : "gateway_starting",
    chatModelId: process.env.OPENCLAW_CHAT_MODEL || null,
    sandbox: {
      enabled: true,
      type: "remote",
    },
    webSearch: {
      available: webSearchAvailable,
      provider: webSearchProvider,
      reason: webSearchAvailable ? null : "missing_web_search_provider_key",
    },
    pricing: {
      configured: false,
      model: null,
    },
  };
}

async function handleInviteRedeem(request, response) {
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  const inviteMatch = requestUrl.pathname.match(/^\/(?:api\/)?auth\/invite\/([a-f0-9]{64})$/);
  if (!inviteMatch) {
    return false;
  }

  if (request.method !== "GET") {
    sendApiError(response, 405, "Method not allowed");
    return true;
  }

  const sessionPool = await getSessionPool(response);
  if (!sessionPool) {
    return true;
  }

  const result = await redeemInvite(sessionPool, inviteMatch[1]);
  if (result.error) {
    const messages = {
      not_found: "Invite not found",
      revoked: "This invite has been revoked",
      expired: "This invite has expired",
    };
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!DOCTYPE html><html><body><h1>${messages[result.error] || "Invalid invite"}</h1><p>Please contact Stratum 3 Ventures for a new invite link.</p></body></html>`);
    return true;
  }

  setInvestorCookie(response, result.jwt, result.expiresAt);
  const frontendUrl = process.env.RAILWAY_SERVICE_LEXIE_NEW_FRONTEND_URL;
  const redirectTo = frontendUrl ? `https://${frontendUrl}` : "/";
  response.writeHead(302, { location: redirectTo });
  response.end();
  return true;
}

async function handleApiRequest(request, response) {
  const requestUrl = new URL(request.url, "http://127.0.0.1");

  // --- Resolve investor identity from cookie (non-blocking) ---
  const investor = await resolveInvestor(request);
  if (investor) {
    request._investorClientId = investorClientId(investor.inviteId);
  }
  const apiActor = resolveApiActor(request, investor);

  // --- Auth routes ---
  if (requestUrl.pathname === "/api/auth/me") {
    if (request.method !== "GET") {
      sendApiError(response, 405, "Method not allowed");
      return true;
    }

    if (investor) {
      sendJson(response, 200, {
        type: "investor",
        name: investor.name,
        inviteId: investor.inviteId,
      });
      return true;
    }

    if (apiActor?.kind === "internal") {
      sendJson(response, 200, { type: "internal" });
      return true;
    }

    sendApiError(response, 401, "Not authenticated");
    return true;
  }

  if (requestUrl.pathname === "/api/auth/logout") {
    if (request.method !== "POST") {
      sendApiError(response, 405, "Method not allowed");
      return true;
    }

    if (investor && pool) {
      try {
        await pool.query(
          `UPDATE investor_sessions SET revoked_at = NOW() WHERE id = $1`,
          [investor.sessionId],
        );
      } catch (error) {
        logError(`logout session revoke failed: ${error.message}`);
      }
    }

    clearInvestorCookie(response);
    sendJson(response, 200, { ok: true });
    return true;
  }

  // --- Admin routes (ops token protected) ---
  if (requestUrl.pathname === "/api/admin/invites") {
    const auth = verifyOpsToken(request);
    if (!auth.ok) {
      sendApiError(response, auth.statusCode, auth.message);
      return true;
    }

    const sessionPool = await getSessionPool(response);
    if (!sessionPool) {
      return true;
    }

    if (request.method === "GET") {
      const invites = await listInvites(sessionPool);
      sendJson(response, 200, invites);
      return true;
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendApiError(response, 400, error.message || "Invalid JSON body");
        return true;
      }

      if (!body.investorName) {
        sendApiError(response, 400, "investorName is required");
        return true;
      }

      const invite = await createInvite(sessionPool, {
        investorName: body.investorName,
        investorEmail: body.investorEmail,
        expiresInDays: body.expiresInDays,
      });

      const frontendHost = process.env.RAILWAY_SERVICE_LEXIE_NEW_FRONTEND_URL;
      const host = frontendHost || request.headers.host || "localhost";
      const protocol = frontendHost ? "https" : (request.headers["x-forwarded-proto"] || "https");
      sendJson(response, 201, {
        ...invite,
        inviteUrl: `${protocol}://${host}/api/auth/invite/${invite.token}`,
      });
      return true;
    }

    sendApiError(response, 405, "Method not allowed");
    return true;
  }

  const adminInviteMatch = requestUrl.pathname.match(/^\/api\/admin\/invites\/([^/]+)$/);
  if (adminInviteMatch) {
    const auth = verifyOpsToken(request);
    if (!auth.ok) {
      sendApiError(response, auth.statusCode, auth.message);
      return true;
    }

    if (request.method !== "DELETE") {
      sendApiError(response, 405, "Method not allowed");
      return true;
    }

    const sessionPool = await getSessionPool(response);
    if (!sessionPool) {
      return true;
    }

    await revokeInvite(sessionPool, adminInviteMatch[1]);
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/agent/chat-capabilities") {
    if (!apiActor) {
      sendApiError(response, 401, "Not authenticated");
      return true;
    }
    sendJson(response, 200, buildChatCapabilities());
    return true;
  }

  if (requestUrl.pathname === "/api/ops/agent-jobs") {
    if (request.method !== "POST") {
      sendApiError(response, 405, "Method not allowed");
      return true;
    }

    const auth = verifyOpsToken(request);
    if (!auth.ok) {
      sendApiError(response, auth.statusCode, auth.message);
      return true;
    }

    if (!gatewayReady) {
      sendApiError(response, 503, "Gateway not ready");
      return true;
    }

    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendApiError(response, 400, error.message || "Invalid JSON body");
      return true;
    }

    const agent = String(body.agent || "ops-agent").trim();
    const systemPrompt = String(body.systemPrompt || "").trim();
    const userPrompt = String(body.userPrompt || "").trim();
    const timeoutMs = parseInteger(body.timeoutMs, 120000);
    if (!userPrompt) {
      sendApiError(response, 400, "userPrompt is required");
      return true;
    }

    const outputText = await runOpsPrompt({
      host: INTERNAL_GATEWAY_HOST,
      port: INTERNAL_GATEWAY_PORT,
      agent,
      systemPrompt,
      userPrompt,
      gatewayToken: OPENCLAW_GATEWAY_REMOTE_TOKEN,
      timeoutMs,
    });
    sendJson(response, 200, { agent, outputText });
    return true;
  }

  if (requestUrl.pathname === "/api/sessions") {
    if (!apiActor) {
      sendApiError(response, 401, "Not authenticated");
      return true;
    }
    const clientId = apiActor.clientId;
    if (!clientId) {
      sendApiError(response, 400, "A valid X-Lexie-Client-Id header is required");
      return true;
    }

    const sessionPool = await getSessionPool(response);
    if (!sessionPool) {
      return true;
    }

    if (request.method === "GET") {
      const status = normalizeSessionStatus(
        requestUrl.searchParams.get("status"),
        SESSION_STATUS.ACTIVE,
      );
      if (!status) {
        sendApiError(response, 400, "Invalid session status");
        return true;
      }

      const sessions = await listSessions(sessionPool, { clientId, status });
      sendJson(response, 200, sessions);
      return true;
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendApiError(response, 400, error.message || "Invalid JSON body");
        return true;
      }

      const agentId = apiActor.kind === "investor" ? INVESTOR_AGENT_ID : OPENCLAW_AGENT_ID;
      const created = await createSession(sessionPool, {
        clientId,
        name: body.name || DEFAULT_SESSION_NAME,
        agentId,
      });
      sendJson(response, 201, created);
      return true;
    }

    sendApiError(response, 405, "Method not allowed");
    return true;
  }

  const touchMatch = requestUrl.pathname.match(/^\/api\/sessions\/([^/]+)\/touch$/);
  if (touchMatch) {
    if (request.method !== "POST") {
      sendApiError(response, 405, "Method not allowed");
      return true;
    }

    if (!apiActor) {
      sendApiError(response, 401, "Not authenticated");
      return true;
    }
    const clientId = apiActor.clientId;
    if (!clientId) {
      sendApiError(response, 400, "A valid X-Lexie-Client-Id header is required");
      return true;
    }

    const sessionPool = await getSessionPool(response);
    if (!sessionPool) {
      return true;
    }

    const touched = await touchSession(sessionPool, {
      sessionId: touchMatch[1],
      clientId,
    });
    if (!touched) {
      sendApiError(response, 404, "Session not found");
      return true;
    }

    sendJson(response, 200, touched);
    return true;
  }

  const sessionMatch = requestUrl.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    if (!apiActor) {
      sendApiError(response, 401, "Not authenticated");
      return true;
    }
    const clientId = apiActor.clientId;
    if (!clientId) {
      sendApiError(response, 400, "A valid X-Lexie-Client-Id header is required");
      return true;
    }

    const sessionPool = await getSessionPool(response);
    if (!sessionPool) {
      return true;
    }

    if (request.method === "PATCH") {
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendApiError(response, 400, error.message || "Invalid JSON body");
        return true;
      }

      const status =
        body.status === undefined
          ? undefined
          : normalizeSessionStatus(body.status);
      if (body.status !== undefined && !status) {
        sendApiError(response, 400, "Invalid session status");
        return true;
      }

      const updated = await updateSession(sessionPool, {
        sessionId: sessionMatch[1],
        clientId,
        name: body.name,
        status,
      });
      if (!updated) {
        sendApiError(response, 404, "Session not found");
        return true;
      }

      sendJson(response, 200, updated);
      return true;
    }

    if (request.method === "DELETE") {
      const deleted = await deleteSession(sessionPool, {
        sessionId: sessionMatch[1],
        clientId,
      });
      if (!deleted) {
        sendApiError(response, 404, "Session not found");
        return true;
      }

      sendJson(response, 200, { ok: true });
      return true;
    }

    sendApiError(response, 405, "Method not allowed");
    return true;
  }

  if (requestUrl.pathname.startsWith("/api/")) {
    sendApiError(response, 404, "Not found");
    return true;
  }

  return false;
}

const server = http.createServer((request, response) => {
  if (request.url === "/healthz") {
    const payload = JSON.stringify({
      status: gatewayReady ? "ok" : "starting",
      gatewayReady,
      sessionStoreReady,
    });
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(payload);
    return;
  }

  Promise.resolve(handleInviteRedeem(request, response))
    .then((handled) => {
      if (handled) return true;
      return handleControlUiRequest(request, response);
    })
    .then((handled) => {
      if (handled) return true;
      return handleApiRequest(request, response);
    })
    .then((handled) => {
      if (!handled) {
        proxyHttpRequest(request, response);
      }
    })
    .catch((error) => {
      logError(`request handling failed: ${error.stack || error.message}`);
      if (!response.headersSent) {
        sendApiError(response, 500, "Internal server error");
      } else {
        response.end();
      }
    });
});

server.on("upgrade", proxyUpgradeRequest);

server.listen(PORT, LISTEN_HOST, () => {
  log(`wrapper listening on ${LISTEN_HOST}:${PORT}`);
  void ensureSessionStore();
  startGateway().catch((error) => {
    logError(`gateway start failed: ${error.stack || error.message}`);
  });
});

async function shutdown(signal) {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  log(`received ${signal}, shutting down`);
  shuttingDown = true;
  gatewayReady = false;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  shutdownPromise = (async () => {
    await new Promise((resolve) => {
      server.close(resolve);
    });

    if (pool) {
      try {
        await pool.end();
      } catch (error) {
        logError(`session store shutdown failed: ${error.stack || error.message}`);
      }
    }

    if (gatewayProcess) {
      await new Promise((resolve) => {
        gatewayProcess.once("exit", resolve);
        gatewayProcess.kill(signal);
      });
    }

    await stopGateway(`shutdown ${signal}`, { tolerateFailure: true });
    process.exit(0);
  })();

  return shutdownPromise;
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
