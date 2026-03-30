const DEFAULT_INTERNAL_EMAIL_DOMAINS = [
  "@nohup.group",
  "@stratum3ventures.com",
  "@stratum3.org",
];

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

function normalizeEmailDomain(value) {
  const normalized = normalizeEmail(value);
  if (!normalized) {
    return "";
  }
  return normalized.startsWith("@") ? normalized : `@${normalized}`;
}

function parseAllowedInternalEmailDomains(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeEmailDomain(entry))
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => normalizeEmailDomain(entry))
      .filter(Boolean);
  }

  return [...DEFAULT_INTERNAL_EMAIL_DOMAINS];
}

function isAllowedInternalEmail(email, domains = DEFAULT_INTERNAL_EMAIL_DOMAINS) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedDomains = parseAllowedInternalEmailDomains(domains);
  return Boolean(
    normalizedEmail &&
      normalizedDomains.some((domain) => normalizedEmail.endsWith(domain)),
  );
}

function resolveTrustedInternalUser(input, options = {}) {
  const proxyToken = options.proxyToken || "";
  const allowedEmailDomains =
    options.allowedEmailDomains || options.allowedEmailDomain || DEFAULT_INTERNAL_EMAIL_DOMAINS;

  if (!hasMatchingProxyToken(input, proxyToken)) {
    return null;
  }

  const forwardedUser = normalizeEmail(extractForwardedUser(input));
  if (!isAllowedInternalEmail(forwardedUser, allowedEmailDomains)) {
    return null;
  }

  return forwardedUser;
}

module.exports = {
  DEFAULT_INTERNAL_EMAIL_DOMAINS,
  extractForwardedUser,
  hasMatchingProxyToken,
  isAllowedInternalEmail,
  normalizeEmail,
  parseAllowedInternalEmailDomains,
  resolveTrustedInternalUser,
};
