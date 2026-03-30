import { getBrowserClientId } from "./browser-client";
import { getGatewayClient } from "./openclaw-gateway";
import type {
  AgentChatHistoryResponse,
  GatewayChatAttachment,
  OpenClawChatCapabilities,
  Session,
  SessionStatus,
} from "./types";

export const LEXIE_CLIENT_ID_HEADER = "X-Lexie-Client-Id";

async function readError(response: Response): Promise<string> {
  try {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = (await response.json()) as { error?: unknown };
      if (typeof data.error === "string" && data.error.trim()) {
        return data.error;
      }
    }
    const text = await response.text();
    return text || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options?: { includeContentType?: boolean },
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(LEXIE_CLIENT_ID_HEADER, getBrowserClientId());
  if (options?.includeContentType !== false && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(input, {
    ...init,
    headers,
  });
}

export async function listSessions(
  status: "active" | "archived" = "active",
): Promise<Session[]> {
  const response = await apiFetch(`/api/sessions?status=${status}`, {
    method: "GET",
  }, { includeContentType: false });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return (await response.json()) as Session[];
}

export async function createSession(name = "New chat"): Promise<Session> {
  return await createSessionForAgent(name);
}

export async function createSessionForAgent(
  name = "New chat",
  agentId?: string | null,
): Promise<Session> {
  const response = await apiFetch("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      name,
      ...(agentId ? { agentId } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return (await response.json()) as Session;
}

export async function updateSession(
  sessionId: string,
  data: { name?: string; status?: SessionStatus },
): Promise<Session> {
  const response = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return (await response.json()) as Session;
}

export async function deleteSession(
  sessionId: string,
): Promise<{ ok: boolean }> {
  const response = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  }, { includeContentType: false });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return (await response.json()) as { ok: boolean };
}

export async function touchSession(sessionId: string): Promise<Session> {
  const response = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/touch`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return (await response.json()) as Session;
}

export async function fetchOpenClawChatCapabilities(): Promise<OpenClawChatCapabilities> {
  const response = await apiFetch("/api/agent/chat-capabilities", {
    method: "GET",
  }, { includeContentType: false });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return (await response.json()) as OpenClawChatCapabilities;
}

export async function fetchAgentChatHistory(
  sessionKey: string,
  limit = 200,
): Promise<AgentChatHistoryResponse> {
  return await getGatewayClient().getChatHistory(sessionKey, limit);
}

export async function abortAgentChat(params: {
  sessionKey: string;
  runId: string;
}): Promise<{ ok?: boolean; aborted?: boolean }> {
  return await getGatewayClient().abortChat(params);
}

export async function patchAgentChatPreferences(params: {
  sessionKey: string;
  webSearchEnabled: boolean;
}): Promise<{ ok?: boolean; sessionKey?: string; webSearchEnabled?: boolean }> {
  return await getGatewayClient().patchChatPreferences(params);
}

export async function streamAgentChat(_params: {
  sessionKey: string;
  prompt: string;
  idempotencyKey: string;
  attachments?: GatewayChatAttachment[];
  onEvent: (event: "started" | "chat" | "agent" | "done" | "error", payload: unknown) => void;
  signal?: AbortSignal;
}): Promise<void> {
  throw new Error("HTTP transport is disabled for lexie-new-frontend");
}
