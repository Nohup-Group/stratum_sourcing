import type { OpenClawQueueMode, OpenClawVerboseLevel } from "./types";
import { getBrowserClientId } from "./browser-client";

const GATEWAY_PROTOCOL_VERSION = 3;
const GATEWAY_CLIENT_ID = "openclaw-control-ui";
const GATEWAY_CLIENT_MODE = "webchat";
const GATEWAY_TOOL_EVENTS_CAP = "tool-events";
const DEFAULT_GATEWAY_WS_PATH = "/api/openclaw/ws";

let cachedGatewayToken: string | null = null;

async function fetchGatewayToken(): Promise<string | null> {
  if (cachedGatewayToken) return cachedGatewayToken;
  try {
    const res = await fetch("/api/gateway-token", { credentials: "same-origin" });
    if (res.ok) {
      const data = (await res.json()) as { token?: string };
      cachedGatewayToken = typeof data.token === "string" ? data.token : null;
      return cachedGatewayToken;
    }
  } catch {
    // Ignore - token is optional
  }
  return null;
}
const CHAT_HISTORY_RESULT_TTL_MS = 250;
const INITIAL_RECONNECT_BACKOFF_MS = 1_500;
const MAX_RECONNECT_BACKOFF_MS = 30_000;

type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message?: string };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type ChatHistoryResponse = {
  messages?: unknown[];
  sessionKey?: string;
  webSearchEnabled?: boolean;
  verboseLevel?: OpenClawVerboseLevel;
  queueMode?: OpenClawQueueMode;
};

type CachedChatHistory = {
  expiresAt: number;
  value: ChatHistoryResponse;
};

export type GatewayGapInfo = {
  expected: number;
  received: number;
};

type EventListener = (event: GatewayEventFrame) => void;
type GapListener = (info: GatewayGapInfo) => void;
type StatusListener = (connected: boolean) => void;

function gatewayWsUrl(path = DEFAULT_GATEWAY_WS_PATH): string {
  const url = new URL(path, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("client_id", getBrowserClientId());
  return url.toString();
}

function errorFromUnknown(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === "string" ? error : fallback);
}

export class GatewayClient {
  private readonly url: string;

  private ws: WebSocket | null = null;

  private connectPromise: Promise<void> | null = null;

  private resolveConnect: (() => void) | null = null;

  private rejectConnect: ((error: Error) => void) | null = null;

  private connectRequestId: string | null = null;

  private challengeTimer: number | null = null;

  private pending = new Map<string, PendingRequest>();

  private chatHistoryInflight = new Map<string, Promise<ChatHistoryResponse>>();

  private chatHistoryCache = new Map<string, CachedChatHistory>();

  private chatHistoryVersions = new Map<string, number>();

  private listeners = new Set<EventListener>();

  private gapListeners = new Set<GapListener>();

  private statusListeners = new Set<StatusListener>();

  private reconnectTimer: number | null = null;

  private reconnectBackoffMs = INITIAL_RECONNECT_BACKOFF_MS;

  private connected = false;

  private intentionalClose = false;

  private lastSeq: number | null = null;

  constructor(path = DEFAULT_GATEWAY_WS_PATH) {
    this.url = gatewayWsUrl(path);
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onGap(listener: GapListener): () => void {
    this.gapListeners.add(listener);
    return () => this.gapListeners.delete(listener);
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  async connect(): Promise<void> {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectPromise) {
      return await this.connectPromise;
    }

    this.intentionalClose = false;
    this.clearReconnectTimer();

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });

    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.clearChallengeTimer();
      this.challengeTimer = window.setTimeout(() => {
        if (this.connected) {
          return;
        }
        this.failConnect(new Error("OpenClaw connect challenge timed out"));
        this.ws?.close(1008, "connect challenge timeout");
      }, 5000);
    };
    this.ws.onmessage = (event) => {
      this.handleMessage(String(event.data ?? ""));
    };
    this.ws.onclose = (event) => {
      this.handleClose(event.code, event.reason || "");
    };
    this.ws.onerror = () => {
      if (this.connected || !this.connectPromise) {
        return;
      }
      this.failConnect(new Error("OpenClaw connection failed"));
    };

    return await this.connectPromise;
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.clearChallengeTimer();
    this.ws?.close(1000, "client disconnect");
    this.ws = null;
    this.connected = false;
    this.lastSeq = null;
    this.chatHistoryInflight.clear();
    this.chatHistoryCache.clear();
    this.chatHistoryVersions.clear();
    this.notifyStatus(false);
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    await this.connect();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("OpenClaw gateway is not connected");
    }

    const id = crypto.randomUUID();
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });

    this.ws.send(
      JSON.stringify({
        type: "req",
        id,
        method,
        params,
      }),
    );

    return await promise;
  }

  async sendChat(params: {
    sessionKey: string;
    message: string;
    idempotencyKey: string;
    attachments?: Array<{
      type?: string;
      mimeType?: string;
      fileName?: string;
      content?: string;
    }>;
  }): Promise<{ runId?: string; status?: string }> {
    this.clearChatHistoryCache(params.sessionKey);
    return await this.request("chat.send", params);
  }

  async abortChat(params: {
    sessionKey: string;
    runId: string;
  }): Promise<{ ok?: boolean; aborted?: boolean }> {
    this.clearChatHistoryCache(params.sessionKey);
    return await this.request("chat.abort", params);
  }

  async patchChatPreferences(params: {
    sessionKey: string;
    webSearchEnabled: boolean;
  }): Promise<{ ok?: boolean; sessionKey?: string; webSearchEnabled?: boolean }> {
    this.clearChatHistoryCache(params.sessionKey);
    return await this.request("chat.preferences.patch", params);
  }

  async patchSessionSettings(params: {
    sessionKey: string;
    verboseLevel?: OpenClawVerboseLevel | null;
    queueMode?: OpenClawQueueMode | null;
  }): Promise<{ ok?: boolean; key?: string }> {
    this.clearChatHistoryCache(params.sessionKey);
    return await this.request("sessions.patch", {
      key: params.sessionKey,
      ...(params.verboseLevel !== undefined ? { verboseLevel: params.verboseLevel } : {}),
      ...(params.queueMode !== undefined ? { queueMode: params.queueMode } : {}),
    });
  }

  async waitForRun(
    runId: string,
    timeoutMs = 600_000,
  ): Promise<{ runId?: string; status?: string; error?: unknown }> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remainingMs = Math.max(0, deadline - Date.now());
      try {
        return await this.request("agent.wait", { runId, timeoutMs: remainingMs });
      } catch (error) {
        const resolvedError = errorFromUnknown(error, "OpenClaw wait failed");
        if (
          !/not connected|closed|connection failed|challenge timed out/i.test(
            resolvedError.message,
          )
        ) {
          throw resolvedError;
        }
        if (Date.now() >= deadline) {
          throw resolvedError;
        }
        await this.delay(300);
      }
    }
  }

  async patchSessionModel(sessionKey: string, model: string): Promise<void> {
    const modelOverride = model.trim() === "openclaw" ? null : model.trim();
    await this.request("sessions.patch", { key: sessionKey, model: modelOverride });
  }

  async getChatHistory(
    sessionKey: string,
    limit = 200,
  ): Promise<ChatHistoryResponse> {
    const cacheKey = this.getChatHistoryCacheKey(sessionKey, limit);
    const cached = this.chatHistoryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const inflight = this.chatHistoryInflight.get(cacheKey);
    if (inflight) {
      return await inflight;
    }

    const version = this.getChatHistoryVersion(sessionKey);
    const requestPromise = this.request<ChatHistoryResponse>("chat.history", {
      sessionKey,
      limit,
    })
      .then((response) => {
        if (this.getChatHistoryVersion(sessionKey) === version) {
          this.chatHistoryCache.set(cacheKey, {
            value: response,
            expiresAt: Date.now() + CHAT_HISTORY_RESULT_TTL_MS,
          });
        }
        return response;
      })
      .finally(() => {
        this.chatHistoryInflight.delete(cacheKey);
      });
    this.chatHistoryInflight.set(cacheKey, requestPromise);
    return await requestPromise;
  }

  private getChatHistoryCacheKey(sessionKey: string, limit: number): string {
    return `${sessionKey}:${limit}`;
  }

  private clearChatHistoryCache(sessionKey: string): void {
    this.chatHistoryVersions.set(sessionKey, this.getChatHistoryVersion(sessionKey) + 1);
    for (const key of this.chatHistoryInflight.keys()) {
      if (key.startsWith(`${sessionKey}:`)) {
        this.chatHistoryInflight.delete(key);
      }
    }
    for (const key of this.chatHistoryCache.keys()) {
      if (key.startsWith(`${sessionKey}:`)) {
        this.chatHistoryCache.delete(key);
      }
    }
  }

  private getChatHistoryVersion(sessionKey: string): number {
    return this.chatHistoryVersions.get(sessionKey) ?? 0;
  }

  private handleMessage(raw: string): void {
    let parsed: GatewayEventFrame | GatewayResponseFrame;
    try {
      parsed = JSON.parse(raw) as GatewayEventFrame | GatewayResponseFrame;
    } catch {
      return;
    }

    if (parsed.type === "event") {
      const seq = typeof parsed.seq === "number" ? parsed.seq : null;
      if (seq !== null) {
        if (this.lastSeq !== null && seq > this.lastSeq + 1) {
          const info = { expected: this.lastSeq + 1, received: seq };
          this.gapListeners.forEach((listener) => listener(info));
        }
        this.lastSeq = seq;
      }

      if (parsed.event === "connect.challenge") {
        this.sendConnect();
        return;
      }

      this.listeners.forEach((listener) => listener(parsed));
      return;
    }

    if (parsed.id === this.connectRequestId) {
      this.connectRequestId = null;
      if (parsed.ok) {
        this.completeConnect();
      } else {
        this.failConnect(
          new Error(parsed.error?.message || "OpenClaw connect rejected"),
        );
      }
      return;
    }

    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return;
    }
    this.pending.delete(parsed.id);

    if (parsed.ok) {
      pending.resolve(parsed.payload);
      return;
    }

    pending.reject(new Error(parsed.error?.message || "OpenClaw request failed"));
  }

  private sendConnect(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.connectRequestId) {
      return;
    }
    void this.sendConnectAsync();
  }

  private async sendConnectAsync(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.connectRequestId) {
      return;
    }
    const token = await fetchGatewayToken();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.connectRequestId) {
      return;
    }
    this.connectRequestId = crypto.randomUUID();
    const params: Record<string, unknown> = {
      minProtocol: GATEWAY_PROTOCOL_VERSION,
      maxProtocol: GATEWAY_PROTOCOL_VERSION,
      client: {
        id: GATEWAY_CLIENT_ID,
        version: "ncf-agent-frontend",
        platform: "web",
        mode: GATEWAY_CLIENT_MODE,
      },
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      caps: [GATEWAY_TOOL_EVENTS_CAP],
      locale: navigator.language,
      userAgent: navigator.userAgent,
    };
    if (token) {
      params.auth = { token };
    }
    this.ws.send(
      JSON.stringify({
        type: "req",
        id: this.connectRequestId,
        method: "connect",
        params,
      }),
    );
  }

  private completeConnect(): void {
    this.clearChallengeTimer();
    this.connected = true;
    this.reconnectBackoffMs = INITIAL_RECONNECT_BACKOFF_MS;
    const resolve = this.resolveConnect;
    this.connectPromise = null;
    this.resolveConnect = null;
    this.rejectConnect = null;
    resolve?.();
    this.notifyStatus(true);
  }

  private failConnect(error: Error): void {
    this.clearChallengeTimer();
    const reject = this.rejectConnect;
    this.connectPromise = null;
    this.resolveConnect = null;
    this.rejectConnect = null;
    this.connected = false;
    reject?.(error);
  }

  private handleClose(code: number, reason: string): void {
    this.clearChallengeTimer();
    this.ws = null;
    this.connected = false;
    this.lastSeq = null;
    this.connectRequestId = null;

    const closeError = new Error(
      `OpenClaw gateway closed (${code}${reason ? `: ${reason}` : ""})`,
    );
    this.failConnect(closeError);

    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(closeError);
    }

    this.notifyStatus(false);

    if (!this.intentionalClose) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }
    const delayMs = this.reconnectBackoffMs;
    this.reconnectBackoffMs = Math.min(
      Math.round(this.reconnectBackoffMs * 1.8),
      MAX_RECONNECT_BACKOFF_MS,
    );
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {
        this.scheduleReconnect();
      });
    }, delayMs + Math.round(Math.random() * 250));
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) {
      return;
    }
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearChallengeTimer(): void {
    if (this.challengeTimer === null) {
      return;
    }
    window.clearTimeout(this.challengeTimer);
    this.challengeTimer = null;
  }

  private notifyStatus(connected: boolean): void {
    this.statusListeners.forEach((listener) => listener(connected));
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => window.setTimeout(resolve, ms));
  }
}

let gatewayClient: GatewayClient | null = null;

export function getGatewayClient(): GatewayClient {
  gatewayClient ??= new GatewayClient();
  return gatewayClient;
}
