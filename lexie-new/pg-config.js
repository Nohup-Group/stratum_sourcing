function createPgPoolConfig(connectionString, rawSslMode = process.env.PGSSLMODE || "") {
  let sslMode = rawSslMode;
  try {
    const url = new URL(connectionString);
    sslMode = url.searchParams.get("sslmode") || sslMode;
  } catch {
    // Let pg raise malformed URL errors later.
  }

  const normalized = String(sslMode || "").trim().toLowerCase();
  let ssl;
  if (normalized === "require") {
    ssl = { rejectUnauthorized: false };
  } else if (normalized === "verify-ca" || normalized === "verify-full") {
    ssl = { rejectUnauthorized: true };
  }

  return {
    connectionString,
    ssl,
  };
}

module.exports = {
  createPgPoolConfig,
};
