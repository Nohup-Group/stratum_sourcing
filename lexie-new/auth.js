const { randomUUID, randomBytes, createHmac } = require("crypto");

const INVESTOR_JWT_SECRET = process.env.INVESTOR_JWT_SECRET || "";
const DEFAULT_INVITE_EXPIRY_DAYS = 14;

// ---------------------------------------------------------------------------
// Database bootstrap
// ---------------------------------------------------------------------------

async function ensureAuthTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS investor_invites (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      token VARCHAR(64) NOT NULL UNIQUE,
      investor_name VARCHAR(255) NOT NULL,
      investor_email VARCHAR(255),
      expires_at TIMESTAMPTZ NOT NULL,
      redeemed_at TIMESTAMPTZ,
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS investor_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      invite_id UUID NOT NULL REFERENCES investor_invites(id),
      jwt_hash VARCHAR(64) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// ---------------------------------------------------------------------------
// JWT helpers (HMAC-SHA256, no dependencies)
// ---------------------------------------------------------------------------

function base64url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signJwt(payload) {
  if (!INVESTOR_JWT_SECRET) {
    throw new Error("INVESTOR_JWT_SECRET is not configured");
  }
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signature = base64url(
    createHmac("sha256", INVESTOR_JWT_SECRET)
      .update(`${header}.${body}`)
      .digest(),
  );
  return `${header}.${body}.${signature}`;
}

function verifyJwt(token) {
  if (!INVESTOR_JWT_SECRET || typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [header, body, signature] = parts;
  const expected = base64url(
    createHmac("sha256", INVESTOR_JWT_SECRET)
      .update(`${header}.${body}`)
      .digest(),
  );

  if (signature !== expected) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    );
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function hashJwt(token) {
  return createHmac("sha256", "jwt-hash-salt").update(token).digest("hex");
}

// ---------------------------------------------------------------------------
// Invite management
// ---------------------------------------------------------------------------

async function createInvite(pool, { investorName, investorEmail, expiresInDays }) {
  const token = randomBytes(32).toString("hex"); // 64 hex chars
  const days = expiresInDays || DEFAULT_INVITE_EXPIRY_DAYS;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const result = await pool.query(
    `INSERT INTO investor_invites (token, investor_name, investor_email, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id, token, investor_name, investor_email, expires_at, created_at`,
    [token, investorName, investorEmail || null, expiresAt],
  );

  return result.rows[0];
}

async function listInvites(pool) {
  const result = await pool.query(
    `SELECT id, investor_name, investor_email, expires_at, redeemed_at, revoked, created_at
     FROM investor_invites
     ORDER BY created_at DESC`,
  );
  return result.rows;
}

async function revokeInvite(pool, inviteId) {
  await pool.query(
    `UPDATE investor_invites SET revoked = TRUE WHERE id = $1`,
    [inviteId],
  );
  await pool.query(
    `UPDATE investor_sessions SET revoked_at = NOW() WHERE invite_id = $1 AND revoked_at IS NULL`,
    [inviteId],
  );
}

// ---------------------------------------------------------------------------
// Invite redemption → session + JWT
// ---------------------------------------------------------------------------

async function redeemInvite(pool, token) {
  const result = await pool.query(
    `SELECT id, investor_name, investor_email, expires_at, redeemed_at, revoked
     FROM investor_invites
     WHERE token = $1`,
    [token],
  );

  if (result.rows.length === 0) {
    return { error: "not_found" };
  }

  const invite = result.rows[0];

  if (invite.revoked) {
    return { error: "revoked" };
  }

  if (new Date(invite.expires_at) < new Date()) {
    return { error: "expired" };
  }

  // Mark first redemption
  if (!invite.redeemed_at) {
    await pool.query(
      `UPDATE investor_invites SET redeemed_at = NOW() WHERE id = $1`,
      [invite.id],
    );
  }

  // Create session
  const sessionId = randomUUID();
  const sessionExpiry = Math.min(
    new Date(invite.expires_at).getTime(),
    Date.now() + 24 * 60 * 60 * 1000, // 24h rolling
  );
  const expiresAt = new Date(sessionExpiry);

  const jwt = signJwt({
    sub: invite.id,
    sid: sessionId,
    name: invite.investor_name,
    exp: Math.floor(sessionExpiry / 1000),
  });

  await pool.query(
    `INSERT INTO investor_sessions (id, invite_id, jwt_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [sessionId, invite.id, hashJwt(jwt), expiresAt],
  );

  return {
    jwt,
    expiresAt,
    investor: {
      id: invite.id,
      name: invite.investor_name,
      email: invite.investor_email,
    },
  };
}

// ---------------------------------------------------------------------------
// Session verification
// ---------------------------------------------------------------------------

async function verifySession(pool, jwtString) {
  const payload = verifyJwt(jwtString);
  if (!payload) {
    return null;
  }

  const result = await pool.query(
    `SELECT s.id, s.invite_id, s.revoked_at, i.investor_name, i.revoked AS invite_revoked
     FROM investor_sessions s
     JOIN investor_invites i ON i.id = s.invite_id
     WHERE s.id = $1 AND s.revoked_at IS NULL AND i.revoked = FALSE`,
    [payload.sid],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    inviteId: row.invite_id,
    sessionId: row.id,
    name: row.investor_name,
  };
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

const COOKIE_NAME = "lexie_investor";

function parseCookies(cookieHeader) {
  const cookies = {};
  if (typeof cookieHeader !== "string") {
    return cookies;
  }
  for (const pair of cookieHeader.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    cookies[key] = val;
  }
  return cookies;
}

function setInvestorCookie(response, jwt, expiresAt) {
  const maxAge = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
  response.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${jwt}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
  );
}

function clearInvestorCookie(response) {
  response.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  );
}

function getInvestorJwt(request) {
  const cookies = parseCookies(request.headers.cookie);
  return cookies[COOKIE_NAME] || null;
}

module.exports = {
  ensureAuthTables,
  createInvite,
  listInvites,
  revokeInvite,
  redeemInvite,
  verifySession,
  verifyJwt,
  COOKIE_NAME,
  parseCookies,
  setInvestorCookie,
  clearInvestorCookie,
  getInvestorJwt,
};
