import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  LEXIE_CLIENT_ID_HEADER,
  createSession,
  listSessions,
} from "./api";
import { resetBrowserClientIdForTests } from "./browser-client";

describe("api client", () => {
  beforeEach(() => {
    localStorage.clear();
    resetBrowserClientIdForTests();
  });

  it("sends the browser client id header on session requests", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          id: "session-1",
          client_id: "client_1234567890abcdef",
          gateway_session_key: "agent:main:webchat:user:client_1234567890abcdef:session:session-1",
          name: "New chat",
          status: "ACTIVE",
          created_at: "2026-03-16T11:00:00.000Z",
          updated_at: "2026-03-16T11:00:00.000Z",
        }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    await listSessions();
    await createSession();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const headers = new Headers(call[1]?.headers);
      expect(headers.get(LEXIE_CLIENT_ID_HEADER)).toMatch(/^client_[a-z0-9]{32}$/i);
    }
  });
});
