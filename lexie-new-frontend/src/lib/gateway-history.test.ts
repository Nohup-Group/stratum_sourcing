import { describe, expect, it } from "vitest";

import { normalizeGatewayConversation } from "./gateway-history";

describe("normalizeGatewayConversation", () => {
  it("trims directive leftovers, drops empty assistant entries, and collapses failover user replays", () => {
    expect(
      normalizeGatewayConversation([
        {
          role: "user",
          content: [{ type: "text", text: "Hey wie gehts" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: " Gut, danke — ich bin bereit." }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "wie sieht dein file system aus?" }],
        },
        {
          role: "assistant",
          content: [],
        },
        {
          role: "assistant",
          content: [],
        },
        {
          role: "user",
          content: [{ type: "text", text: "wie sieht dein file system aus?" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: " Kurzüberblick vom aktuellen Dateisystem" }],
        },
      ]),
    ).toEqual([
      { role: "user", content: "Hey wie gehts" },
      { role: "assistant", content: "Gut, danke — ich bin bereit." },
      { role: "user", content: "wie sieht dein file system aus?" },
      { role: "assistant", content: "Kurzüberblick vom aktuellen Dateisystem" },
    ]);
  });
});
