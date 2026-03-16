const http = require("http");
const net = require("net");
const { spawn } = require("child_process");
const { Pool } = require("pg");
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
const DATABASE_URL = process.env.DATABASE_URL || "";
const LEXIE_OPS_TOKEN = process.env.LEXIE_OPS_TOKEN || "";
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

function createPgPoolConfig(connectionString) {
  let sslMode = process.env.PGSSLMODE || "";
  try {
    const url = new URL(connectionString);
    sslMode = url.searchParams.get("sslmode") || sslMode;
  } catch {
    // Let pg raise malformed URL errors later.
  }

  const needsSsl = /require|verify-ca|verify-full/i.test(sslMode);
  return {
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  };
}

function log(message) {
  process.stdout.write(`[lexie-new] ${message}\n`);
}

function logError(message) {
  process.stderr.write(`[lexie-new] ${message}\n`);
}

async function ensureSessionStore() {
  if (!pool) {
    sessionStoreReady = false;
    return;
  }

  try {
    await ensureChatSessionsTable(pool);
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
    gatewayReady = false;

    if (!shuttingDown) {
      restartTimer = setTimeout(() => {
        restartTimer = null;
        startGateway().catch((error) => {
          logError(`gateway restart failed: ${error.stack || error.message}`);
        });
      }, 2000);
    }
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
  const forwardedUser = normalizeClientId(requestUrl.searchParams.get("client_id"));
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
  const clientId = normalizeClientId(request.headers["x-lexie-client-id"]);
  return clientId || "";
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

function resolveClientId(request) {
  return normalizeClientId(request.headers["x-lexie-client-id"]);
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

async function handleApiRequest(request, response) {
  const requestUrl = new URL(request.url, "http://127.0.0.1");

  if (request.method === "GET" && requestUrl.pathname === "/api/agent/chat-capabilities") {
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
      gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN || "",
      timeoutMs,
    });
    sendJson(response, 200, { agent, outputText });
    return true;
  }

  if (requestUrl.pathname === "/api/sessions") {
    const clientId = resolveClientId(request);
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

      const created = await createSession(sessionPool, {
        clientId,
        name: body.name || DEFAULT_SESSION_NAME,
        agentId: OPENCLAW_AGENT_ID,
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

    const clientId = resolveClientId(request);
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
    const clientId = resolveClientId(request);
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

  Promise.resolve(handleApiRequest(request, response))
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
