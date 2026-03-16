const { randomUUID } = require("crypto");

const DEFAULT_SESSION_NAME = "New chat";
const DEFAULT_AGENT_ID = "main";
const SESSION_STATUS = {
  ACTIVE: "ACTIVE",
  ARCHIVED: "ARCHIVED",
};
const VALID_CLIENT_ID = /^[a-zA-Z0-9_-]{16,128}$/;

function normalizeClientId(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!VALID_CLIENT_ID.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function normalizeSessionStatus(value, fallback = SESSION_STATUS.ACTIVE) {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  const normalized = value.trim().toUpperCase();
  if (normalized === SESSION_STATUS.ACTIVE || normalized === SESSION_STATUS.ARCHIVED) {
    return normalized;
  }
  return null;
}

function normalizeSessionName(value) {
  if (typeof value !== "string") {
    return DEFAULT_SESSION_NAME;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 120) : DEFAULT_SESSION_NAME;
}

function buildGatewaySessionKey(sessionId, clientId, agentId = DEFAULT_AGENT_ID) {
  return `agent:${agentId}:webchat:user:${clientId}:session:${sessionId}`;
}

function splitAllowedOrigins(value) {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function detectWebSearchProvider(env) {
  const providerEntries = [
    ["perplexity", env.PERPLEXITY_API_KEY],
    ["xai", env.XAI_API_KEY],
    ["gemini", env.GEMINI_API_KEY],
    ["kimi", env.KIMI_API_KEY],
    ["brave", env.BRAVE_API_KEY],
  ];

  for (const [provider, key] of providerEntries) {
    if (typeof key === "string" && key.trim()) {
      return provider;
    }
  }

  return null;
}

async function ensureChatSessionsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id UUID PRIMARY KEY,
      client_id TEXT NOT NULL,
      gateway_session_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chat_sessions_status_check CHECK (status IN ('ACTIVE', 'ARCHIVED'))
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS chat_sessions_client_status_updated_idx
    ON chat_sessions (client_id, status, updated_at DESC)
  `);
}

function mapSessionRow(row) {
  return {
    id: row.id,
    client_id: row.client_id,
    gateway_session_key: row.gateway_session_key,
    name: row.name,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listSessions(pool, { clientId, status }) {
  const result = await pool.query(
    `
      SELECT id, client_id, gateway_session_key, name, status, created_at, updated_at
      FROM chat_sessions
      WHERE client_id = $1 AND status = $2
      ORDER BY updated_at DESC
    `,
    [clientId, status],
  );
  return result.rows.map(mapSessionRow);
}

async function createSession(pool, { clientId, name, agentId }) {
  const id = randomUUID();
  const normalizedName = normalizeSessionName(name);
  const gatewaySessionKey = buildGatewaySessionKey(id, clientId, agentId);
  const result = await pool.query(
    `
      INSERT INTO chat_sessions (id, client_id, gateway_session_key, name, status)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, client_id, gateway_session_key, name, status, created_at, updated_at
    `,
    [id, clientId, gatewaySessionKey, normalizedName, SESSION_STATUS.ACTIVE],
  );
  return mapSessionRow(result.rows[0]);
}

async function updateSession(pool, { sessionId, clientId, name, status }) {
  const fields = [];
  const values = [sessionId, clientId];
  let parameterIndex = 3;

  if (name !== undefined) {
    fields.push(`name = $${parameterIndex}`);
    values.push(normalizeSessionName(name));
    parameterIndex += 1;
  }

  if (status !== undefined) {
    fields.push(`status = $${parameterIndex}`);
    values.push(status);
    parameterIndex += 1;
  }

  if (fields.length === 0) {
    return null;
  }

  fields.push("updated_at = NOW()");
  const result = await pool.query(
    `
      UPDATE chat_sessions
      SET ${fields.join(", ")}
      WHERE id = $1 AND client_id = $2
      RETURNING id, client_id, gateway_session_key, name, status, created_at, updated_at
    `,
    values,
  );
  return result.rows[0] ? mapSessionRow(result.rows[0]) : null;
}

async function deleteSession(pool, { sessionId, clientId }) {
  const result = await pool.query(
    `
      DELETE FROM chat_sessions
      WHERE id = $1 AND client_id = $2
    `,
    [sessionId, clientId],
  );
  return result.rowCount > 0;
}

async function touchSession(pool, { sessionId, clientId }) {
  const result = await pool.query(
    `
      UPDATE chat_sessions
      SET updated_at = NOW()
      WHERE id = $1 AND client_id = $2
      RETURNING id, client_id, gateway_session_key, name, status, created_at, updated_at
    `,
    [sessionId, clientId],
  );
  return result.rows[0] ? mapSessionRow(result.rows[0]) : null;
}

module.exports = {
  DEFAULT_AGENT_ID,
  DEFAULT_SESSION_NAME,
  SESSION_STATUS,
  buildGatewaySessionKey,
  createSession,
  deleteSession,
  detectWebSearchProvider,
  ensureChatSessionsTable,
  listSessions,
  normalizeClientId,
  normalizeSessionName,
  normalizeSessionStatus,
  splitAllowedOrigins,
  touchSession,
  updateSession,
};
