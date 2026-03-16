import { describe, expect, it } from "vitest";

import { authoritativeSessionHasAssistantReply } from "./authoritative-history";
import type { SessionDetail } from "./types";

function buildDetail(messages: SessionDetail["messages"]): Pick<SessionDetail, "messages"> {
  return { messages };
}

describe("authoritativeSessionHasAssistantReply", () => {
  it("matches the latest assistant reply after whitespace normalization", () => {
    expect(
      authoritativeSessionHasAssistantReply(
        buildDetail([
          {
            id: "1",
            ordinal: 1,
            role: "user",
            content: "Question",
            created_at: "2026-03-10T10:00:00.000Z",
          },
          {
            id: "2",
            ordinal: 2,
            role: "assistant",
            content: "  Final   answer  ",
            created_at: "2026-03-10T10:00:02.000Z",
          },
        ]),
        "Final answer",
      ),
    ).toBe(true);
  });

  it("ignores older assistant replies when the latest assistant is different", () => {
    expect(
      authoritativeSessionHasAssistantReply(
        buildDetail([
          {
            id: "1",
            ordinal: 1,
            role: "assistant",
            content: "Old answer",
            created_at: "2026-03-10T10:00:00.000Z",
          },
          {
            id: "2",
            ordinal: 2,
            role: "user",
            content: "Next question",
            created_at: "2026-03-10T10:01:00.000Z",
          },
          {
            id: "3",
            ordinal: 3,
            role: "assistant",
            content: "Different answer",
            created_at: "2026-03-10T10:01:02.000Z",
          },
        ]),
        "Old answer",
      ),
    ).toBe(false);
  });
});
