import type { AgentMessagePart } from "./types";

const SESSION_LIVE_RUN_STORAGE_KEY = "openclaw-session-live-run-v1";

export interface SessionLiveRunSnapshot {
  sessionKey: string;
  runId: string;
  assistantText: string;
  parts: AgentMessagePart[];
  updatedAt: number;
}

type SessionLiveRunStore = Record<string, SessionLiveRunSnapshot>;

function loadStore(): SessionLiveRunStore {
  try {
    const raw = localStorage.getItem(SESSION_LIVE_RUN_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as SessionLiveRunStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveStore(store: SessionLiveRunStore): void {
  localStorage.setItem(SESSION_LIVE_RUN_STORAGE_KEY, JSON.stringify(store));
}

export function readSessionLiveRun(
  sessionKey: string | null | undefined,
): SessionLiveRunSnapshot | null {
  if (!sessionKey) {
    return null;
  }
  const snapshot = loadStore()[sessionKey];
  return snapshot ?? null;
}

export function writeSessionLiveRun(snapshot: SessionLiveRunSnapshot): void {
  const store = loadStore();
  store[snapshot.sessionKey] = snapshot;
  saveStore(store);
}

export function clearSessionLiveRun(sessionKey: string | null | undefined): void {
  if (!sessionKey) {
    return;
  }
  const store = loadStore();
  if (!(sessionKey in store)) {
    return;
  }
  delete store[sessionKey];
  saveStore(store);
}
