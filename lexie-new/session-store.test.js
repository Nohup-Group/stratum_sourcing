const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SESSION_STATUS,
  buildGatewaySessionKey,
  createSession,
  deleteSession,
  listSessions,
  normalizeClientId,
  normalizeSessionStatus,
  touchSession,
  updateSession,
} = require("./session-store");

function createMockPool(returnValue = { rows: [], rowCount: 0 }) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return returnValue;
    },
  };
}

test("normalizeClientId accepts safe opaque ids", () => {
  assert.equal(
    normalizeClientId("client_1234567890abcdef"),
    "client_1234567890abcdef",
  );
  assert.equal(normalizeClientId("too-short"), null);
  assert.equal(normalizeClientId("bad id"), null);
});

test("normalizeSessionStatus accepts active and archived values", () => {
  assert.equal(normalizeSessionStatus("active"), SESSION_STATUS.ACTIVE);
  assert.equal(normalizeSessionStatus("ARCHIVED"), SESSION_STATUS.ARCHIVED);
  assert.equal(normalizeSessionStatus("invalid"), null);
});

test("buildGatewaySessionKey uses agent id, client id, and session id", () => {
  assert.equal(
    buildGatewaySessionKey("session-123", "client_1234567890abcdef", "main"),
    "agent:main:webchat:user:client_1234567890abcdef:session:session-123",
  );
});

test("listSessions scopes queries by client id and status", async () => {
  const pool = createMockPool();
  await listSessions(pool, {
    clientId: "client_1234567890abcdef",
    status: SESSION_STATUS.ACTIVE,
  });

  assert.deepEqual(pool.calls[0].params, [
    "client_1234567890abcdef",
    SESSION_STATUS.ACTIVE,
  ]);
});

test("updateSession includes the client id ownership guard", async () => {
  const pool = createMockPool();
  await updateSession(pool, {
    sessionId: "session-123",
    clientId: "client_1234567890abcdef",
    name: "Renamed",
    status: SESSION_STATUS.ARCHIVED,
  });

  assert.equal(pool.calls[0].params[0], "session-123");
  assert.equal(pool.calls[0].params[1], "client_1234567890abcdef");
});

test("deleteSession and touchSession use the same ownership scope", async () => {
  const deletePool = createMockPool();
  await deleteSession(deletePool, {
    sessionId: "session-123",
    clientId: "client_1234567890abcdef",
  });
  assert.deepEqual(deletePool.calls[0].params, [
    "session-123",
    "client_1234567890abcdef",
  ]);

  const touchPool = createMockPool();
  await touchSession(touchPool, {
    sessionId: "session-123",
    clientId: "client_1234567890abcdef",
  });
  assert.deepEqual(touchPool.calls[0].params, [
    "session-123",
    "client_1234567890abcdef",
  ]);
});

test("createSession persists a generated gateway session key", async () => {
  const pool = createMockPool({
    rows: [
      {
        id: "generated-session-id",
        client_id: "client_1234567890abcdef",
        gateway_session_key:
          "agent:main:webchat:user:client_1234567890abcdef:session:generated-session-id",
        name: "New chat",
        status: "ACTIVE",
        created_at: "2026-03-16T12:00:00.000Z",
        updated_at: "2026-03-16T12:00:00.000Z",
      },
    ],
    rowCount: 1,
  });

  const created = await createSession(pool, {
    clientId: "client_1234567890abcdef",
    name: "New chat",
    agentId: "main",
  });

  assert.equal(created.client_id, "client_1234567890abcdef");
  assert.match(
    pool.calls[0].params[2],
    /^agent:main:webchat:user:client_1234567890abcdef:session:/,
  );
});
