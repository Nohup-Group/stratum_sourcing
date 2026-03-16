const crypto = require("crypto");
const WebSocket = require("ws");

const GATEWAY_PROTOCOL_VERSION = 3;

function createError(message) {
  return new Error(message);
}

async function runOpsPrompt({
  host,
  port,
  agent,
  systemPrompt,
  userPrompt,
  timeoutMs = 120000,
}) {
  const sessionKey = `ops-${agent || "agent"}-${crypto.randomUUID()}`;
  const idempotencyKey = `ops-${crypto.randomUUID()}`;
  const message = systemPrompt
    ? `[System]\n${systemPrompt}\n\n[User]\n${userPrompt}`
    : userPrompt;

  const ws = new WebSocket(`ws://${host}:${port}`);
  const pending = new Map();
  const chatChunks = [];
  let timeoutHandle = null;
  let settled = false;

  function cleanup() {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    for (const pendingRequest of pending.values()) {
      pendingRequest.reject(createError("OpenClaw socket closed before response"));
    }
    pending.clear();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }

  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  return await new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(createError("OpenClaw ops prompt timed out"));
      }
    }, timeoutMs);

    ws.on("message", async (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (frame.type === "event" && frame.event === "connect.challenge") {
        try {
          await request("connect", {
            minProtocol: GATEWAY_PROTOCOL_VERSION,
            maxProtocol: GATEWAY_PROTOCOL_VERSION,
            client: {
              id: "lexie-ops",
              version: "1.0",
              platform: "node",
            },
            role: "operator",
            scopes: ["operator.admin", "operator.read", "operator.write"],
            caps: [],
            commands: [],
          });
          await request("chat.send", {
            sessionKey,
            message,
            idempotencyKey,
          });
        } catch (error) {
          if (!settled) {
            settled = true;
            cleanup();
            reject(error);
          }
        }
        return;
      }

      if (frame.type === "event" && frame.event === "chat") {
        const payload = frame.payload || {};
        const payloads = Array.isArray(payload.payloads) ? payload.payloads : [];
        for (const item of payloads) {
          if (item && item.text && !item.isError) {
            chatChunks.push(item.text);
          }
        }
        if (payload.state === "final") {
          if (!settled) {
            settled = true;
            cleanup();
            resolve(chatChunks.join("").trim());
          }
          return;
        }
        if (payload.state === "error") {
          const errorText = payloads
            .filter((item) => item && item.isError && item.text)
            .map((item) => item.text)
            .join(" ")
            .trim();
          if (!settled) {
            settled = true;
            cleanup();
            reject(createError(errorText || "OpenClaw returned an error"));
          }
        }
        return;
      }

      if (frame.type !== "res") {
        return;
      }

      const pendingRequest = pending.get(frame.id);
      if (!pendingRequest) {
        return;
      }
      pending.delete(frame.id);
      if (frame.ok) {
        pendingRequest.resolve(frame.payload);
      } else {
        pendingRequest.reject(
          createError(frame.error?.message || "OpenClaw request failed"),
        );
      }
    });

    ws.on("error", (error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    });

    ws.on("close", () => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(createError("OpenClaw socket closed unexpectedly"));
      }
    });
  });
}

module.exports = {
  runOpsPrompt,
};
