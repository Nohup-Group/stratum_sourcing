const KEY_STORAGE = "console_key";

export function getKey(): string | null {
  return localStorage.getItem(KEY_STORAGE);
}

export function setKey(key: string) {
  localStorage.setItem(KEY_STORAGE, key);
}

export function clearKey() {
  localStorage.removeItem(KEY_STORAGE);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const key = getKey();
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "X-Console-Key": key } : {}),
      ...(init?.headers || {}),
    },
  });
  if (response.status === 401) {
    clearKey();
    window.location.assign("/login");
    throw new ApiError(401, "Unauthorized");
  }
  if (!response.ok) {
    throw new ApiError(response.status, await response.text());
  }
  return response.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
};
