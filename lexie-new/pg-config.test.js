const assert = require("node:assert/strict");
const test = require("node:test");

const { createPgPoolConfig } = require("./pg-config");

test("createPgPoolConfig keeps require mode encrypted without verification", () => {
  const config = createPgPoolConfig("postgres://user:pass@db.example.com/app?sslmode=require");
  assert.deepEqual(config.ssl, { rejectUnauthorized: false });
});

test("createPgPoolConfig verifies certificates for verify-full", () => {
  const config = createPgPoolConfig(
    "postgres://user:pass@db.example.com/app?sslmode=verify-full",
  );
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
});

test("createPgPoolConfig leaves ssl undefined for non-strict modes", () => {
  const config = createPgPoolConfig("postgres://user:pass@db.example.com/app?sslmode=prefer");
  assert.equal(config.ssl, undefined);
});
