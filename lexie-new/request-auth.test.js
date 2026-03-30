const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_INTERNAL_EMAIL_DOMAINS,
  hasMatchingProxyToken,
  isAllowedInternalEmail,
  parseAllowedInternalEmailDomains,
  resolveTrustedInternalUser,
} = require("./request-auth");

test("hasMatchingProxyToken accepts bearer and proxy headers", () => {
  assert.equal(
    hasMatchingProxyToken({ authorization: "Bearer secret-token" }, "secret-token"),
    true,
  );
  assert.equal(
    hasMatchingProxyToken({ "x-openclaw-control-ui-auth": "secret-token" }, "secret-token"),
    true,
  );
});

test("resolveTrustedInternalUser accepts trusted nohup emails", () => {
  const request = {
    headers: {
      authorization: "Bearer shared-secret",
      "x-forwarded-user": "Operator@Nohup.Group",
    },
  };

  assert.equal(
    resolveTrustedInternalUser(request, { proxyToken: "shared-secret" }),
    "operator@nohup.group",
  );
});

test("resolveTrustedInternalUser accepts trusted stratum emails", () => {
  const request = {
    headers: {
      authorization: "Bearer shared-secret",
      "x-forwarded-user": "jaime@stratum3ventures.com",
    },
  };

  assert.equal(
    resolveTrustedInternalUser(request, { proxyToken: "shared-secret" }),
    "jaime@stratum3ventures.com",
  );
});

test("resolveTrustedInternalUser rejects anonymous client-id requests", () => {
  const request = {
    headers: {
      "x-lexie-client-id": "client_1234567890abcdef1234567890abcd",
      "x-forwarded-user": "operator@nohup.group",
    },
  };

  assert.equal(
    resolveTrustedInternalUser(request, { proxyToken: "shared-secret" }),
    null,
  );
});

test("resolveTrustedInternalUser rejects non-nohup emails", () => {
  const request = {
    headers: {
      authorization: "Bearer shared-secret",
      "x-forwarded-user": "contractor@example.com",
    },
  };

  assert.equal(
    resolveTrustedInternalUser(request, { proxyToken: "shared-secret" }),
    null,
  );
  assert.equal(isAllowedInternalEmail("contractor@example.com"), false);
});

test("parseAllowedInternalEmailDomains normalizes configured domains", () => {
  assert.deepEqual(parseAllowedInternalEmailDomains("nohup.group,@stratum3ventures.com"), [
    "@nohup.group",
    "@stratum3ventures.com",
  ]);
  assert.deepEqual(parseAllowedInternalEmailDomains(undefined), DEFAULT_INTERNAL_EMAIL_DOMAINS);
});
