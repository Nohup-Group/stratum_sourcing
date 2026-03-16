export const BROWSER_CLIENT_STORAGE_KEY = "stratum-lexie-browser-id";

let cachedBrowserClientId: string | null = null;

export function isValidBrowserClientId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^client_[a-z0-9]{32}$/i.test(value);
}

export function createBrowserClientId(): string {
  return `client_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function getBrowserClientId(): string {
  if (cachedBrowserClientId) {
    return cachedBrowserClientId;
  }

  if (typeof window === "undefined") {
    cachedBrowserClientId = "client_serverbootstrap000000000000";
    return cachedBrowserClientId;
  }

  const stored = window.localStorage.getItem(BROWSER_CLIENT_STORAGE_KEY);
  if (isValidBrowserClientId(stored)) {
    cachedBrowserClientId = stored;
    return stored;
  }

  const nextId = createBrowserClientId();
  window.localStorage.setItem(BROWSER_CLIENT_STORAGE_KEY, nextId);
  cachedBrowserClientId = nextId;
  return nextId;
}

export function resetBrowserClientIdForTests(): void {
  cachedBrowserClientId = null;
}
