import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  readSessionLiveRun,
  writeSessionLiveRun,
} from "@/lib/session-live-run";
import { useMessages } from "./use-messages";
import type { ChatMessage } from "@/lib/types";

const apiMocks = vi.hoisted(() => ({
  abortAgentChat: vi.fn(),
  fetchAgentChatHistory: vi.fn(),
  streamAgentChat: vi.fn(),
}));

const gatewayClient = {
  disconnect: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  onGap: vi.fn(() => () => {}),
  onStatusChange: vi.fn(() => () => {}),
  connect: vi.fn(async () => {}),
  getChatHistory: vi.fn(),
  sendChat: vi.fn(),
  waitForRun: vi.fn(),
  abortChat: vi.fn(),
};

let gatewayEventListener:
  | ((event: { event: string; payload?: unknown }) => void)
  | null = null;

vi.mock("@/lib/openclaw-gateway", () => ({
  getGatewayClient: () => gatewayClient,
}));

vi.mock("@/lib/api", () => apiMocks);

function message(
  role: ChatMessage["role"],
  content: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    role,
    content,
    ...overrides,
  };
}

describe("useMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    gatewayEventListener = null;
    gatewayClient.subscribe.mockImplementation((listener) => {
      gatewayEventListener = listener as typeof gatewayEventListener;
      return () => {
        if (gatewayEventListener === listener) {
          gatewayEventListener = null;
        }
      };
    });
    gatewayClient.onGap.mockImplementation(() => () => {});
    gatewayClient.onStatusChange.mockImplementation(() => () => {});
    gatewayClient.connect.mockResolvedValue(undefined);
    gatewayClient.getChatHistory.mockResolvedValue({ messages: [] });
    gatewayClient.sendChat.mockResolvedValue(undefined);
    gatewayClient.waitForRun.mockResolvedValue({ status: "done" });
    apiMocks.abortAgentChat.mockResolvedValue(undefined);
    apiMocks.fetchAgentChatHistory.mockResolvedValue({ messages: [] });
    apiMocks.streamAgentChat.mockResolvedValue(undefined);
  });

  it("hydrates persisted ids and timestamps from history", () => {
    const history = [
      message("user", "Question", {
        id: "db-user-1",
        ordinal: 1,
        createdAt: "2026-03-09T10:00:00.000Z",
      }),
      message("assistant", "Answer", {
        id: "db-assistant-1",
        ordinal: 2,
        createdAt: "2026-03-09T10:00:05.000Z",
      }),
    ];

    const { result } = renderHook(() =>
      useMessages({ gatewayEnabled: false, transport: "gateway" }),
    );

    act(() => {
      result.current.setMessagesFromHistory(history);
    });

    expect(result.current.messages.map((entry) => entry.id)).toEqual([
      "db-user-1",
      "db-assistant-1",
    ]);
    expect(result.current.messages.map((entry) => entry.timestamp)).toEqual([
      Date.parse("2026-03-09T10:00:00.000Z") / 1000,
      Date.parse("2026-03-09T10:00:05.000Z") / 1000,
    ]);
  });

  it("does not reattach a stale live snapshot before authoritative history has loaded", () => {
    writeSessionLiveRun({
      sessionKey: "session-1",
      runId: "run-1",
      assistantText: "Mir geht's gut",
      parts: [{ type: "text", text: "Mir geht's gut" }],
      updatedAt: Date.now(),
    });

    const { result } = renderHook(() =>
      useMessages({
        gatewayEnabled: true,
        transport: "gateway",
        activeSessionKey: "session-1",
        activeSessionHistory: [],
        activeSessionHistoryLoaded: false,
      }),
    );

    expect(result.current.messages).toEqual([]);
    expect(readSessionLiveRun("session-1")?.assistantText).toBe(
      "Mir geht's gut",
    );
  });

  it("ignores a late duplicate final assistant event when the same assistant tail is already rendered", () => {
    const history = [
      message("user", "Hallo wie geht es dir", { id: "db-user-1" }),
      message("assistant", "Mir geht's gut, danke dir", {
        id: "db-assistant-1",
      }),
    ];

    const { result } = renderHook(() =>
      useMessages({
        gatewayEnabled: true,
        transport: "gateway",
        activeSessionKey: "session-1",
        activeSessionHistory: history,
        activeSessionHistoryLoaded: true,
      }),
    );

    act(() => {
      result.current.setMessagesFromHistory(history);
    });

    act(() => {
      gatewayEventListener?.({
        event: "chat",
        payload: {
          sessionKey: "session-1",
          runId: "run-1",
          state: "final",
          message: { text: "Mir geht's gut, danke dir" },
        },
      });
    });

    expect(result.current.messages).toHaveLength(2);
    expect(
      result.current.messages.filter((entry) => entry.role === "assistant"),
    ).toHaveLength(1);
  });

  it("adopts the authoritative assistant reply in place after a final live event", async () => {
    const initialHistory = [message("user", "Hallo", { id: "db-user-1" })];

    const { result, rerender } = renderHook(
      ({ activeSessionHistory }: { activeSessionHistory: ChatMessage[] }) =>
        useMessages({
          gatewayEnabled: true,
          transport: "gateway",
          activeSessionKey: "session-1",
          activeSessionHistory,
          activeSessionHistoryLoaded: true,
        }),
      {
        initialProps: {
          activeSessionHistory: initialHistory,
        },
      },
    );

    act(() => {
      result.current.setMessagesFromHistory(initialHistory);
    });

    act(() => {
      gatewayEventListener?.({
        event: "chat",
        payload: {
          sessionKey: "session-1",
          runId: "run-1",
          state: "final",
          message: { text: "Final answer" },
        },
      });
    });

    expect(result.current.isStreaming).toBe(false);
    expect(
      result.current.messages.filter((entry) => entry.role === "assistant"),
    ).toHaveLength(1);
    expect(result.current.messages[1]?.id).not.toBe("db-assistant-9");

    rerender({
      activeSessionHistory: [
        ...initialHistory,
        message("assistant", "Final answer", {
          id: "db-assistant-9",
          createdAt: "2026-03-09T10:02:05.000Z",
        }),
      ],
    });

    await waitFor(() => {
      expect(
        result.current.messages.filter((entry) => entry.role === "assistant"),
      ).toHaveLength(1);
      expect(result.current.messages[1]?.id).toBe("db-assistant-9");
    });
  });

  it("keeps the live assistant message id stable when history catches up mid-stream", () => {
    const initialHistory = [message("user", "Hallo", { id: "db-user-1" })];

    const { result, rerender } = renderHook(
      ({ activeSessionHistory }: { activeSessionHistory: ChatMessage[] }) =>
        useMessages({
          gatewayEnabled: true,
          transport: "gateway",
          activeSessionKey: "session-1",
          activeSessionHistory,
          activeSessionHistoryLoaded: true,
        }),
      {
        initialProps: {
          activeSessionHistory: initialHistory,
        },
      },
    );

    act(() => {
      result.current.setMessagesFromHistory(initialHistory);
    });

    act(() => {
      gatewayEventListener?.({
        event: "chat",
        payload: {
          sessionKey: "session-1",
          runId: "run-1",
          state: "delta",
          message: { text: "Working" },
        },
      });
    });

    const liveAssistantId = result.current.messages[1]?.id;
    expect(result.current.isStreaming).toBe(true);
    expect(liveAssistantId).toBeTruthy();

    rerender({
      activeSessionHistory: [
        ...initialHistory,
        message("assistant", "Working", {
          id: "db-assistant-1",
          createdAt: "2026-03-09T10:02:05.000Z",
        }),
      ],
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.messages[1]?.id).toBe(liveAssistantId);
  });

  it("does not duplicate a settled assistant when authoritative history only changes markdown whitespace", () => {
    const initialHistory = [message("user", "Show me the examples", { id: "db-user-1" })];
    const websocketAssistant =
      "Yes - confirmed with concrete data.\n\n### 1) Examples\n\n- app upload: `content/a.md`\n(`Source type: app_upload`)";
    const authoritativeAssistant =
      "Yes - confirmed with concrete data.\n\n### 1) Examples\n\n  - app upload: `content/a.md`  \n    (`Source type: app_upload`)";

    const { result } = renderHook(() =>
      useMessages({
        gatewayEnabled: true,
        transport: "gateway",
        activeSessionKey: "session-1",
        activeSessionHistory: initialHistory,
        activeSessionHistoryLoaded: true,
      }),
    );

    act(() => {
      result.current.setMessagesFromHistory(initialHistory);
    });

    act(() => {
      gatewayEventListener?.({
        event: "chat",
        payload: {
          sessionKey: "session-1",
          runId: "run-1",
          state: "final",
          message: { text: websocketAssistant },
        },
      });
    });

    act(() => {
      result.current.setMessagesFromHistory([
        ...initialHistory,
        message("assistant", authoritativeAssistant, { id: "db-assistant-1" }),
      ]);
    });

    expect(
      result.current.messages.filter((entry) => entry.role === "assistant"),
    ).toHaveLength(1);
    expect(result.current.messages[1]?.parts).toEqual([
      { type: "text", text: authoritativeAssistant },
    ]);
  });

  it("does not clear a known non-empty session while the gateway key is temporarily unavailable", () => {
    const history = [
      message("user", "Hallo", { id: "db-user-1" }),
      message("assistant", "Antwort", { id: "db-assistant-1" }),
    ];

    const { result, rerender } = renderHook(
      ({
        activeSessionKey,
        activeSessionHistory,
        activeSessionMessageCount,
      }: {
        activeSessionKey?: string | null;
        activeSessionHistory: ChatMessage[];
        activeSessionMessageCount: number;
      }) =>
        useMessages({
          gatewayEnabled: true,
          transport: "gateway",
          activeSessionKey,
          activeSessionHistory,
          activeSessionHistoryLoaded: true,
          activeSessionMessageCount,
        }),
      {
        initialProps: {
          activeSessionKey: "session-1",
          activeSessionHistory: history,
          activeSessionMessageCount: 2,
        },
      },
    );

    act(() => {
      result.current.setMessagesFromHistory(history);
    });

    rerender({
      activeSessionKey: null,
      activeSessionHistory: [],
      activeSessionMessageCount: 2,
    });

    expect(result.current.messages.map((entry) => entry.id)).toEqual([
      "db-user-1",
      "db-assistant-1",
    ]);
  });

  it("keeps the completed assistant visible and triggers one authoritative refresh when settle is delayed", async () => {
    vi.useFakeTimers();
    const requestAuthoritativeSessionRefresh = vi
      .fn()
      .mockResolvedValue(undefined);

    try {
      const initialHistory = [message("user", "Hallo", { id: "db-user-1" })];

      const { result } = renderHook(() =>
        useMessages({
          gatewayEnabled: true,
          transport: "gateway",
          activeSessionKey: "session-1",
          activeSessionHistory: initialHistory,
          activeSessionHistoryLoaded: true,
          requestAuthoritativeSessionRefresh,
        }),
      );

      act(() => {
        result.current.setMessagesFromHistory(initialHistory);
      });

      act(() => {
        gatewayEventListener?.({
          event: "chat",
          payload: {
            sessionKey: "session-1",
            runId: "run-1",
            state: "final",
            message: { text: "Final answer" },
          },
        });
      });

      expect(result.current.isStreaming).toBe(false);
      expect(result.current.messages[1]?.parts).toEqual([
        { type: "text", text: "Final answer" },
      ]);

      await act(async () => {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(3_100);
      });

      expect(requestAuthoritativeSessionRefresh).toHaveBeenCalledWith(
        "session-1",
      );
      expect(result.current.messages[1]?.parts).toEqual([
        { type: "text", text: "Final answer" },
      ]);
      expect(
        result.current.messages.filter((entry) => entry.role === "assistant"),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hydrates persisted tool render parts from authoritative history", () => {
    const history = [
      message("assistant", "Done", {
        id: "db-assistant-2",
        ordinal: 2,
        createdAt: "2026-03-09T10:00:05.000Z",
        renderParts: [
          {
            type: "tool-call",
            toolCall: {
              id: "tool-group:exec",
              name: "exec",
              args: { cmd: "ls", count: 2 },
              status: "done",
              count: 2,
              result: "listing",
            },
          },
          {
            type: "text",
            text: "Done",
          },
        ],
      }),
    ];

    const { result } = renderHook(() =>
      useMessages({ gatewayEnabled: false, transport: "gateway" }),
    );

    act(() => {
      result.current.setMessagesFromHistory(history);
    });

    expect(result.current.messages[0]?.parts).toEqual([
      {
        type: "tool-call",
        toolCall: {
          id: "tool-group:exec",
          name: "exec",
          args: { cmd: "ls", count: 2 },
          status: "done",
          count: 2,
          result: "listing",
        },
      },
      {
        type: "text",
        text: "Done",
      },
    ]);
  });

  it("appends a persisted tail without replacing earlier messages", () => {
    const initialHistory = [
      message("user", "Question 1", { id: "db-user-1" }),
      message("assistant", "Answer 1", { id: "db-assistant-1" }),
    ];
    const persistedTail = [
      message("user", "Question 2", { id: "db-user-2" }),
      message("assistant", "Answer 2", { id: "db-assistant-2" }),
    ];

    const { result } = renderHook(() =>
      useMessages({ gatewayEnabled: false, transport: "gateway" }),
    );

    act(() => {
      result.current.setMessagesFromHistory(initialHistory);
    });

    act(() => {
      result.current.appendMessagesFromHistory(persistedTail);
    });

    expect(result.current.messages.map((entry) => entry.id)).toEqual([
      "db-user-1",
      "db-assistant-1",
      "db-user-2",
      "db-assistant-2",
    ]);
  });

  it("adopts persisted metadata for an already-rendered tail", () => {
    const { result } = renderHook(() =>
      useMessages({ gatewayEnabled: false, transport: "gateway" }),
    );

    act(() => {
      result.current.setMessagesFromHistory([
        message("user", "Question"),
        message("assistant", "Answer"),
      ]);
    });

    expect(result.current.messages.map((entry) => entry.id)).toEqual([
      "history-user-0",
      "history-assistant-1",
    ]);

    act(() => {
      result.current.adoptMessagesFromHistory([
        message("user", "Question", {
          id: "db-user-9",
          createdAt: "2026-03-09T10:02:00.000Z",
        }),
        message("assistant", "Answer", {
          id: "db-assistant-9",
          createdAt: "2026-03-09T10:02:05.000Z",
        }),
      ]);
    });

    expect(result.current.messages.map((entry) => entry.id)).toEqual([
      "db-user-9",
      "db-assistant-9",
    ]);
    expect(result.current.messages.map((entry) => entry.timestamp)).toEqual([
      Date.parse("2026-03-09T10:02:00.000Z") / 1000,
      Date.parse("2026-03-09T10:02:05.000Z") / 1000,
    ]);
  });

  it("surfaces exec tool activity during HTTP streaming", async () => {
    apiMocks.streamAgentChat.mockImplementationOnce(
      async ({
        onEvent,
      }: {
        onEvent: (event: string, payload: unknown) => void;
      }) => {
        onEvent("started", { runId: "run-1" });
        onEvent("agent", {
          stream: "tool",
          data: {
            phase: "start",
            toolCallId: "tool-exec-1",
            name: "exec",
            args: { cmd: "ls -la" },
          },
        });
        onEvent("agent", {
          stream: "tool",
          data: {
            phase: "result",
            toolCallId: "tool-exec-1",
            name: "exec",
            args: { cmd: "ls -la" },
            result: {
              content: [{ type: "text", text: "listing" }],
            },
          },
        });
        onEvent("chat", {
          state: "final",
          message: { text: "Done" },
        });
      },
    );

    const { result } = renderHook(() =>
      useMessages({ gatewayEnabled: false, transport: "http" }),
    );

    await act(async () => {
      await result.current.sendMessage({
        sessionKey: "session-1",
        prompt: "Inspect the workspace",
        recoveryBaseline: [],
      });
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]?.parts).toEqual([
      {
        type: "tool-call",
        toolCall: {
          id: "tool-group:exec",
          name: "exec",
          args: { cmd: "ls -la", count: 1 },
          status: "done",
          count: 1,
          result: "listing",
        },
      },
      {
        type: "text",
        text: "Done",
      },
    ]);
  });

  it("collapses repeated same-name tool calls into one grouped entry", async () => {
    apiMocks.streamAgentChat.mockImplementationOnce(
      async ({
        onEvent,
      }: {
        onEvent: (event: string, payload: unknown) => void;
      }) => {
        onEvent("started", { runId: "run-1" });
        onEvent("agent", {
          stream: "tool",
          data: {
            phase: "start",
            toolCallId: "tool-exec-1",
            name: "exec",
            args: { cmd: "ls -la" },
          },
        });
        onEvent("agent", {
          stream: "tool",
          data: {
            phase: "result",
            toolCallId: "tool-exec-1",
            name: "exec",
            args: { cmd: "ls -la" },
            result: {
              content: [{ type: "text", text: "listing" }],
            },
          },
        });
        onEvent("agent", {
          stream: "tool",
          data: {
            phase: "start",
            toolCallId: "tool-exec-2",
            name: "exec",
            args: { cmd: "pwd" },
          },
        });
        onEvent("agent", {
          stream: "tool",
          data: {
            phase: "result",
            toolCallId: "tool-exec-2",
            name: "exec",
            args: { cmd: "pwd" },
            result: {
              content: [{ type: "text", text: "/workspace" }],
            },
          },
        });
        onEvent("chat", {
          state: "final",
          message: { text: "Done" },
        });
      },
    );

    const { result } = renderHook(() =>
      useMessages({ gatewayEnabled: false, transport: "http" }),
    );

    await act(async () => {
      await result.current.sendMessage({
        sessionKey: "session-1",
        prompt: "Inspect the workspace",
        recoveryBaseline: [],
      });
    });

    const toolPart = result.current.messages[0]?.parts[0];
    expect(toolPart).toEqual({
      type: "tool-call",
      toolCall: {
        id: "tool-group:exec",
        name: "exec",
        args: { cmd: "pwd", count: 2 },
        status: "done",
        count: 2,
        result: "/workspace",
      },
    });
  });

  it("merges a persisted tool-only assistant tail with the active run", () => {
    const { result, rerender } = renderHook(
      ({ activeSessionHistory }: { activeSessionHistory: ChatMessage[] }) =>
        useMessages({
          gatewayEnabled: true,
          transport: "gateway",
          activeSessionKey: "session-1",
          activeSessionHistory,
          activeSessionHistoryLoaded: true,
        }),
      {
        initialProps: {
          activeSessionHistory: [message("user", "Inspect the workspace")],
        },
      },
    );

    act(() => {
      gatewayEventListener?.({
        event: "agent",
        payload: {
          sessionKey: "session-1",
          runId: "run-1",
          stream: "tool",
          data: {
            phase: "start",
            toolCallId: "tool-exec-1",
            name: "exec",
            args: { cmd: "ls -la" },
          },
        },
      });
    });

    expect(
      result.current.messages.filter((entry) => entry.role === "assistant"),
    ).toHaveLength(1);

    rerender({
      activeSessionHistory: [
        message("user", "Inspect the workspace"),
        message("assistant", "", {
          id: "db-assistant-1",
          renderParts: [
            {
              type: "tool-call",
              toolCall: {
                id: "tool-group:exec",
                name: "exec",
                args: { cmd: "ls -la", count: 1 },
                status: "done",
                count: 1,
              },
            },
          ],
        }),
      ],
    });

    expect(result.current.messages).toHaveLength(2);
    expect(
      result.current.messages.filter((entry) => entry.role === "assistant"),
    ).toHaveLength(1);
    expect(result.current.messages[1]?.parts).toEqual([
      {
        type: "tool-call",
        toolCall: {
          id: "tool-group:exec",
          name: "exec",
          args: { cmd: "ls -la", count: 1 },
          status: "running",
          count: 1,
          result: undefined,
        },
      },
    ]);
  });

  it("reuses the provided idempotency key and waits on the gateway run id", async () => {
    gatewayClient.sendChat.mockResolvedValueOnce({ runId: "gateway-run-9" });

    const { result } = renderHook(() =>
      useMessages({ gatewayEnabled: true, transport: "gateway" }),
    );

    await act(async () => {
      await result.current.sendMessage({
        sessionKey: "session-1",
        prompt: "Hello",
        idempotencyKey: "client-message-1",
        recoveryBaseline: [],
      });
    });

    expect(gatewayClient.sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "session-1",
        message: "Hello",
        idempotencyKey: "client-message-1",
      }),
    );
    expect(gatewayClient.waitForRun).toHaveBeenCalledWith("gateway-run-9");
  });

  it("keeps a background session run active when switching to another session", async () => {
    let resolveWait: ((value: { status: string }) => void) | null = null;
    gatewayClient.waitForRun.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWait = resolve as typeof resolveWait;
        }),
    );

    const sessionOneHistory = [message("user", "Q1")];
    const sessionTwoHistory = [message("user", "Other")];

    const { result, rerender } = renderHook(
      ({
        activeSessionKey,
        activeSessionHistory,
      }: {
        activeSessionKey: string;
        activeSessionHistory: ChatMessage[];
      }) =>
        useMessages({
          gatewayEnabled: true,
          transport: "gateway",
          activeSessionKey,
          activeSessionHistory,
          activeSessionHistoryLoaded: true,
        }),
      {
        initialProps: {
          activeSessionKey: "session-1",
          activeSessionHistory: sessionOneHistory,
        },
      },
    );

    act(() => {
      result.current.setMessagesFromHistory(sessionOneHistory);
      result.current.addUserMessage({ prompt: "Q2" });
    });

    const sendPromise = result.current.sendMessage({
      sessionKey: "session-1",
      prompt: "Q2",
      recoveryBaseline: [message("user", "Q1"), message("user", "Q2")],
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isStreaming).toBe(true);
    expect(result.current.isSessionStreaming("session-1")).toBe(true);

    rerender({
      activeSessionKey: "session-2",
      activeSessionHistory: sessionTwoHistory,
    });

    act(() => {
      result.current.setMessagesFromHistory(sessionTwoHistory);
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.isSessionStreaming("session-1")).toBe(true);
    expect(result.current.messages.map((entry) => entry.role)).toEqual([
      "user",
    ]);

    resolveWait?.({ status: "done" });
    await act(async () => {
      await sendPromise;
    });
  });

  it("reattaches a live run after reload and resumes chat/tool updates", async () => {
    writeSessionLiveRun({
      sessionKey: "session-1",
      runId: "run-live-1",
      assistantText: "Teilantwort",
      parts: [{ type: "text", text: "Teilantwort" }],
      updatedAt: Date.now(),
    });

    const { result, rerender } = renderHook(
      ({ activeSessionHistory }: { activeSessionHistory: ChatMessage[] }) =>
        useMessages({
          gatewayEnabled: true,
          transport: "gateway",
          activeSessionKey: "session-1",
          activeSessionHistory,
          activeSessionHistoryLoaded: true,
        }),
      {
        initialProps: {
          activeSessionHistory: [message("user", "Frage")],
        },
      },
    );

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    expect(result.current.messages[0]?.parts).toEqual([
      { type: "text", text: "Teilantwort" },
    ]);

    act(() => {
      gatewayEventListener?.({
        event: "agent",
        payload: {
          sessionKey: "session-1",
          runId: "run-live-1",
          stream: "tool",
          data: {
            phase: "start",
            toolCallId: "tool-reload-1",
            name: "exec",
            args: { cmd: "pwd" },
          },
        },
      });
    });

    expect(result.current.messages[0]?.parts[0]).toEqual({
      type: "tool-call",
      toolCall: {
        id: "tool-group:exec",
        name: "exec",
        args: { cmd: "pwd", count: 1 },
        status: "running",
        count: 1,
        result: undefined,
      },
    });

    act(() => {
      gatewayEventListener?.({
        event: "chat",
        payload: {
          sessionKey: "session-1",
          runId: "run-live-1",
          state: "delta",
          message: { text: "Teilantwort erweitert" },
        },
      });
    });

    expect(result.current.messages[0]?.parts).toEqual([
      {
        type: "tool-call",
        toolCall: {
          id: "tool-group:exec",
          name: "exec",
          args: { cmd: "pwd", count: 1 },
          status: "running",
          count: 1,
          result: undefined,
        },
      },
      { type: "text", text: "Teilantwort erweitert" },
    ]);

    act(() => {
      gatewayEventListener?.({
        event: "chat",
        payload: {
          sessionKey: "session-1",
          runId: "run-live-1",
          state: "final",
          message: { text: "Fertig" },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
    });
    expect(readSessionLiveRun("session-1")).not.toBeNull();

    rerender({
      activeSessionHistory: [
        message("user", "Frage"),
        message("assistant", "Fertig"),
      ],
    });

    await waitFor(() => {
      expect(readSessionLiveRun("session-1")).toBeNull();
    });
  });

  it("does not recover a previous assistant reply when history has no new assistant tail", async () => {
    gatewayClient.getChatHistory.mockResolvedValueOnce({
      messages: [
        { role: "user", content: [{ type: "text", text: "Q1" }] },
        { role: "assistant", content: [{ type: "text", text: "A1" }] },
        { role: "user", content: [{ type: "text", text: "Q2" }] },
      ],
    });
    gatewayClient.waitForRun.mockResolvedValueOnce({ status: "timeout" });

    const { result } = renderHook(() =>
      useMessages({ gatewayEnabled: true, transport: "gateway" }),
    );

    act(() => {
      result.current.setMessagesFromHistory([
        message("user", "Q1"),
        message("assistant", "A1"),
      ]);
      result.current.addUserMessage({ prompt: "Q2" });
    });

    await act(async () => {
      await result.current.sendMessage({
        sessionKey: "session-1",
        prompt: "Q2",
        recoveryBaseline: [
          message("user", "Q1"),
          message("assistant", "A1"),
          message("user", "Q2"),
        ],
      });
    });

    expect(
      result.current.messages
        .filter((entry) => entry.role === "assistant")
        .map((entry) =>
          entry.parts
            .filter(
              (part): part is { type: "text"; text: string } =>
                part.type === "text",
            )
            .map((part) => part.text)
            .join(""),
        ),
    ).toEqual(["A1", ""]);
  });

  it("recovers the current assistant reply only when history appends a new assistant tail", async () => {
    gatewayClient.getChatHistory.mockResolvedValueOnce({
      messages: [
        { role: "user", content: [{ type: "text", text: "Q1" }] },
        { role: "assistant", content: [{ type: "text", text: "A1" }] },
        { role: "user", content: [{ type: "text", text: "Q2" }] },
        { role: "assistant", content: [{ type: "text", text: "A2" }] },
      ],
    });
    gatewayClient.waitForRun.mockResolvedValueOnce({ status: "timeout" });

    const { result } = renderHook(() =>
      useMessages({ gatewayEnabled: true, transport: "gateway" }),
    );

    act(() => {
      result.current.setMessagesFromHistory([
        message("user", "Q1"),
        message("assistant", "A1"),
      ]);
      result.current.addUserMessage({ prompt: "Q2" });
    });

    await act(async () => {
      await result.current.sendMessage({
        sessionKey: "session-1",
        prompt: "Q2",
        recoveryBaseline: [
          message("user", "Q1"),
          message("assistant", "A1"),
          message("user", "Q2"),
        ],
      });
    });

    expect(
      result.current.messages
        .filter((entry) => entry.role === "assistant")
        .map((entry) =>
          entry.parts
            .filter(
              (part): part is { type: "text"; text: string } =>
                part.type === "text",
            )
            .map((part) => part.text)
            .join(""),
        ),
    ).toEqual(["A1", "A2"]);
  });

  it("recovers through failover history that contains empty assistant steps and a replayed user turn", async () => {
    gatewayClient.getChatHistory.mockResolvedValueOnce({
      messages: [
        { role: "user", content: [{ type: "text", text: "Q1" }] },
        { role: "assistant", content: [{ type: "text", text: " A1" }] },
        { role: "user", content: [{ type: "text", text: "Q2" }] },
        { role: "assistant", content: [] },
        { role: "assistant", content: [] },
        { role: "user", content: [{ type: "text", text: "Q2" }] },
        { role: "assistant", content: [{ type: "text", text: " A2" }] },
      ],
    });
    gatewayClient.waitForRun.mockResolvedValueOnce({ status: "timeout" });

    const { result } = renderHook(() =>
      useMessages({ gatewayEnabled: true, transport: "gateway" }),
    );

    act(() => {
      result.current.setMessagesFromHistory([
        message("user", "Q1"),
        message("assistant", "A1"),
      ]);
      result.current.addUserMessage({ prompt: "Q2" });
    });

    await act(async () => {
      await result.current.sendMessage({
        sessionKey: "session-1",
        prompt: "Q2",
        recoveryBaseline: [
          message("user", "Q1"),
          message("assistant", "A1"),
          message("user", "Q2"),
        ],
      });
    });

    expect(
      result.current.messages
        .filter((entry) => entry.role === "assistant")
        .map((entry) =>
          entry.parts
            .filter(
              (part): part is { type: "text"; text: string } =>
                part.type === "text",
            )
            .map((part) => part.text)
            .join(""),
        ),
    ).toEqual(["A1", "A2"]);
  });
});
