const http = require("http");
const net = require("net");
const { spawn, spawnSync } = require("child_process");

const PORT = parseInteger(process.env.PORT, 8080);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST || "127.0.0.1";
const INTERNAL_GATEWAY_PORT = parseInteger(
  process.env.INTERNAL_GATEWAY_PORT || process.env.OPENCLAW_INTERNAL_PORT,
  18789,
);
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || "/data";
const OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/data/.openclaw";
const OPENCLAW_WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace";

if (!OPENCLAW_GATEWAY_TOKEN) {
  throw new Error("OPENCLAW_GATEWAY_TOKEN is required");
}

let shuttingDown = false;
let gatewayProcess = null;
let gatewayReady = false;
let restartTimer = null;

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function log(message) {
  process.stdout.write(`[lexie-new] ${message}\n`);
}

function logError(message) {
  process.stderr.write(`[lexie-new] ${message}\n`);
}

function runOpenClaw(args, options = {}) {
  return spawnSync("openclaw", args, {
    env: process.env,
    encoding: "utf8",
    ...options,
  });
}

function syncGatewayConfig() {
  const tokenResult = runOpenClaw(
    [
      "config",
      "set",
      "--json",
      "gateway.auth.token",
      JSON.stringify(OPENCLAW_GATEWAY_TOKEN),
    ],
    { stdio: "pipe" },
  );
  if (tokenResult.status !== 0) {
    logError(`failed to sync gateway token: ${tokenResult.stderr.trim()}`);
  }

  const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (!publicDomain) {
    return;
  }

  const origin = `https://${publicDomain}`;
  const originResult = runOpenClaw(
    [
      "config",
      "set",
      "--json",
      "gateway.controlUi.allowedOrigins",
      JSON.stringify([origin]),
    ],
    { stdio: "pipe" },
  );
  if (originResult.status !== 0) {
    logError(`failed to sync allowed origins: ${originResult.stderr.trim()}`);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  syncGatewayConfig();

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
    "--allow-unconfigured",
  ];

  log(
    `starting openclaw gateway on ${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`,
  );
  gatewayProcess = spawn("openclaw", args, {
    env: {
      ...process.env,
      OPENCLAW_HOME,
      OPENCLAW_STATE_DIR,
      OPENCLAW_WORKSPACE_DIR,
    },
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

  const upstream = net.connect(INTERNAL_GATEWAY_PORT, INTERNAL_GATEWAY_HOST, () => {
    let rawRequest = `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      rawRequest += `${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}\r\n`;
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

const server = http.createServer((request, response) => {
  if (request.url === "/healthz") {
    const payload = JSON.stringify({
      status: gatewayReady ? "ok" : "starting",
      gatewayReady,
    });
    response.writeHead(gatewayReady ? 200 : 503, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(payload);
    return;
  }

  proxyHttpRequest(request, response);
});

server.on("upgrade", proxyUpgradeRequest);

server.listen(PORT, () => {
  log(`wrapper listening on ${PORT}`);
  startGateway().catch((error) => {
    logError(`gateway start failed: ${error.stack || error.message}`);
  });
});

function shutdown(signal) {
  log(`received ${signal}, shutting down`);
  shuttingDown = true;
  gatewayReady = false;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  server.close(() => {
    if (gatewayProcess) {
      gatewayProcess.once("exit", () => process.exit(0));
      gatewayProcess.kill(signal);
      return;
    }
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
