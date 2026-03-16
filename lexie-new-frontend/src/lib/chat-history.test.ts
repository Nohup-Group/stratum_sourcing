import { describe, expect, it } from "vitest";

import {
  getMissingHistoryTail,
  resolveChatHistorySync,
} from "./chat-history";
import type { ChatMessage } from "./types";

function message(
  role: ChatMessage["role"],
  content: string,
): ChatMessage {
  return { role, content };
}

describe("chat-history", () => {
  it("appends when persisted history is ahead of runtime", () => {
    const runtime = [message("user", "Q1"), message("assistant", "A1")];
    const persisted = [
      ...runtime,
      message("user", "Q2"),
      message("assistant", "A2"),
    ];

    expect(
      resolveChatHistorySync({
        sessionChanged: false,
        runtimeMessages: runtime,
        persistedMessages: persisted,
      }),
    ).toBe("append");
    expect(getMissingHistoryTail(runtime, persisted)).toEqual([
      message("user", "Q2"),
      message("assistant", "A2"),
    ]);
  });

  it("keeps runtime when persisted history is behind", () => {
    const persisted = [message("user", "Q1"), message("assistant", "A1")];
    const runtime = [
      ...persisted,
      message("user", "Q2"),
      message("assistant", "A2"),
    ];

    expect(
      resolveChatHistorySync({
        sessionChanged: false,
        runtimeMessages: runtime,
        persistedMessages: persisted,
      }),
    ).toBe("keep");
  });

  it("replaces when histories diverge", () => {
    const runtime = [
      message("user", "Q1"),
      message("assistant", "A1"),
      message("user", "Q2"),
    ];
    const persisted = [
      message("user", "Q1"),
      message("assistant", "A1"),
      message("user", "Different"),
    ];

    expect(
      resolveChatHistorySync({
        sessionChanged: false,
        runtimeMessages: runtime,
        persistedMessages: persisted,
      }),
    ).toBe("replace");
  });

  it("hydrates on session switch even if runtime already has messages", () => {
    const runtime = [message("user", "Old question")];
    const persisted = [message("user", "New question")];

    expect(
      resolveChatHistorySync({
        sessionChanged: true,
        runtimeMessages: runtime,
        persistedMessages: persisted,
      }),
    ).toBe("hydrate");
  });
});
