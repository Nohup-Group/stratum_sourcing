import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useSessions } from "./use-sessions";

vi.mock("@/lib/api", () => ({
  listSessions: vi.fn(),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  deleteSession: vi.fn(),
}));

import { createSession, listSessions } from "@/lib/api";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useSessions", () => {
  beforeEach(() => {
    vi.mocked(listSessions).mockReset();
    vi.mocked(createSession).mockReset();
  });

  it("selects the most recent active session when available", async () => {
    vi.mocked(listSessions)
      .mockResolvedValueOnce([
        {
          id: "session-1",
          client_id: "client_1234567890abcdef",
          gateway_session_key: "agent:main:webchat:user:client_1234567890abcdef:session:session-1",
          name: "First",
          status: "ACTIVE",
          created_at: "2026-03-16T10:00:00.000Z",
          updated_at: "2026-03-16T10:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([]);

    const { result } = renderHook(() => useSessions(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.sessions.length).toBe(1));
    expect(result.current.currentSessionId).toBe("session-1");
  });

  it("creates a new session and selects it", async () => {
    vi.mocked(listSessions)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "session-2",
          client_id: "client_1234567890abcdef",
          gateway_session_key: "agent:main:webchat:user:client_1234567890abcdef:session:session-2",
          name: "New chat",
          status: "ACTIVE",
          created_at: "2026-03-16T11:00:00.000Z",
          updated_at: "2026-03-16T11:00:00.000Z",
        },
      ])
      .mockResolvedValue([]);
    vi.mocked(createSession).mockResolvedValue({
      id: "session-2",
      client_id: "client_1234567890abcdef",
      gateway_session_key: "agent:main:webchat:user:client_1234567890abcdef:session:session-2",
      name: "New chat",
      status: "ACTIVE",
      created_at: "2026-03-16T11:00:00.000Z",
      updated_at: "2026-03-16T11:00:00.000Z",
    });

    const { result } = renderHook(() => useSessions(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.createSession();
    });

    expect(createSession).toHaveBeenCalledWith("New chat");
    await waitFor(() => expect(result.current.currentSessionId).toBe("session-2"));
  });
});
