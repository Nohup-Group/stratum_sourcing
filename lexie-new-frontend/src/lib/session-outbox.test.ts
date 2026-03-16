import { beforeEach, describe, expect, it } from "vitest";

import {
  confirmSessionOutbox,
  listRenderableOutboxMessages,
  listSessionOutbox,
  patchSessionOutboxItem,
  upsertSessionOutboxItem,
  type SessionOutboxItem,
} from "./session-outbox";

function buildOutboxItem(overrides: Partial<SessionOutboxItem> = {}): SessionOutboxItem {
  return {
    client_message_id: "client-1",
    session_id: "session-1",
    text: "Question",
    attachments: [],
    created_at: Date.parse("2026-03-10T10:00:00.000Z"),
    state: "queued",
    attempt_count: 0,
    ...overrides,
  };
}

describe("session outbox", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps queued items renderable across reloads", () => {
    upsertSessionOutboxItem(buildOutboxItem());

    expect(listSessionOutbox("session-1")).toHaveLength(1);
    expect(listRenderableOutboxMessages("session-1")).toEqual([
      {
        id: "client-1",
        role: "user",
        content: "Question",
        attachments: [],
        createdAt: "2026-03-10T10:00:00.000Z",
      },
    ]);
  });

  it("confirms an outbox item once canonical history contains the user turn", () => {
    upsertSessionOutboxItem(buildOutboxItem());

    const remaining = confirmSessionOutbox("session-1", [
      {
        id: "db-user-1",
        role: "user",
        content: "Question",
        attachments: [],
        createdAt: "2026-03-10T10:00:02.000Z",
      },
    ]);

    expect(remaining).toEqual([]);
    expect(listSessionOutbox("session-1")).toEqual([]);
  });

  it("stops rendering failed items", () => {
    upsertSessionOutboxItem(buildOutboxItem());
    patchSessionOutboxItem("session-1", "client-1", (item) => ({
      ...item,
      state: "failed",
      attempt_count: 3,
    }));

    expect(listRenderableOutboxMessages("session-1")).toEqual([]);
    expect(listSessionOutbox("session-1")).toHaveLength(1);
  });
});
