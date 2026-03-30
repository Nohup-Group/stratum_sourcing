import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "./use-auth";

const BROWSER_CLIENT_ID = "client_1234567890abcdef1234567890abcd";

vi.mock("@/lib/browser-client", () => ({
  getBrowserClientId: () => BROWSER_CLIENT_ID,
}));

describe("useAuth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("marks internal staff requests as authenticated", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        type: "internal",
        email: "operator@nohup.group",
        defaultAgentId: "main",
        availableAgents: [
          { id: "main", name: "Lexie", default: true },
          { id: "investor", name: "Stratum Data Room" },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAuth());

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current).toEqual({
        isLoading: false,
        isAuthenticated: true,
        userType: "internal",
        investorName: null,
        email: "operator@nohup.group",
        availableAgents: [
          { id: "main", name: "Lexie", default: true },
          { id: "investor", name: "Stratum Data Room" },
        ],
        defaultAgentId: "main",
      });
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/me", {
      headers: { "X-Lexie-Client-Id": BROWSER_CLIENT_ID },
    });
  });

  it("captures investor names from the auth response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          type: "investor",
          name: "Jane Investor",
          defaultAgentId: "investor",
          availableAgents: [{ id: "investor", name: "Stratum Data Room", default: true }],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current).toEqual({
        isLoading: false,
        isAuthenticated: true,
        userType: "investor",
        investorName: "Jane Investor",
        email: null,
        availableAgents: [{ id: "investor", name: "Stratum Data Room", default: true }],
        defaultAgentId: "investor",
      });
    });
  });

  it("treats 401 responses as unauthenticated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Not authenticated" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current).toEqual({
        isLoading: false,
        isAuthenticated: false,
        userType: null,
        investorName: null,
        email: null,
        availableAgents: [],
        defaultAgentId: null,
      });
    });
  });

  it("falls back to unauthenticated state when auth lookup fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current).toEqual({
        isLoading: false,
        isAuthenticated: false,
        userType: null,
        investorName: null,
        email: null,
        availableAgents: [],
        defaultAgentId: null,
      });
    });
  });
});
