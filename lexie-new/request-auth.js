const INTERNAL_EMAIL_DOMAIN = "@nohup.group";

function getHeaders(input) {
  if (input && typeof input === "object" && input.headers && typeof input.headers === "object") {
    return input.headers;
  }
  if (input && typeof input === "object") {
    return input;
  }
  return {};
}

function firstHeaderValue(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
    return value[0].trim();
  }
  return "";
}

function normalizeEmail(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function extractForwardedUser(input) {
  const headers = getHeaders(input);
  const candidates = [
    headers["x-forwarded-user"],
    headers["cf-access-authenticated-user-email"],
    headers["x-agent-user-email"],
  ];

  for (const candidate of candidates) {
    const value = firstHeaderValue(candidate);
    if (value) {
      return value;
    }
  }

  return "";
}

function hasMatchingProxyToken(input, expectedToken) {
  if (typeof expectedToken !== "string" || !expectedToken.trim()) {
    return false;
  }

  const token = expectedToken.trim();
  const headers = getHeaders(input);
  const authorization = firstHeaderValue(headers.authorization);
  if (authorization && authorization === `Bearer ${token}`) {
    return true;
  }

  const proxyHeader = firstHeaderValue(headers["x-openclaw-control-ui-auth"]);
  return proxyHeader === token;
}

function isAllowedInternalEmail(email, domain = INTERNAL_EMAIL_DOMAIN) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedDomain = normalizeEmail(domain);
  return Boolean(normalizedEmail && normalizedDomain && normalizedEmail.endsWith(normalizedDomain));
}

function resolveTrustedInternalUser(input, options = {}) {
  const proxyToken = options.proxyToken || "";
  const allowedEmailDomain = options.allowedEmailDomain || INTERNAL_EMAIL_DOMAIN;

  if (!hasMatchingProxyToken(input, proxyToken)) {
    return null;
  }

  const forwardedUser = normalizeEmail(extractForwardedUser(input));
  if (!isAllowedInternalEmail(forwardedUser, allowedEmailDomain)) {
    return null;
  }

  return forwardedUser;
}

module.exports = {
  INTERNAL_EMAIL_DOMAIN,
  extractForwardedUser,
  hasMatchingProxyToken,
  isAllowedInternalEmail,
  normalizeEmail,
  resolveTrustedInternalUser,
};
