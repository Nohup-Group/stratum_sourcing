import type { SessionDetail } from "./types";

function normalizeComparableChatText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function authoritativeSessionHasAssistantReply(
  detail: Pick<SessionDetail, "messages">,
  expectedAssistantText: string,
): boolean {
  const normalizedExpected = normalizeComparableChatText(expectedAssistantText);
  if (!normalizedExpected) {
    return true;
  }

  const latestAssistant = [...detail.messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        normalizeComparableChatText(message.content).length > 0,
    );
  if (!latestAssistant) {
    return false;
  }

  return normalizeComparableChatText(latestAssistant.content) === normalizedExpected;
}
