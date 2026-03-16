import type { ChatMessage } from "./types";
import { sameChatMessage } from "./chat-history";

function extractGatewayVisibleText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }

  const entry = message as {
    text?: unknown;
    content?: unknown;
  };

  if (typeof entry.text === "string") {
    return entry.text;
  }

  if (typeof entry.content === "string") {
    return entry.content;
  }

  if (!Array.isArray(entry.content)) {
    return "";
  }

  return entry.content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const block = part as { type?: unknown; text?: unknown };
      return block.type === "text" && typeof block.text === "string"
        ? block.text
        : "";
    })
    .join("");
}

function normalizeGatewayText(text: string): string {
  return text.trim();
}

export function normalizeGatewayConversation(messages: unknown[]): ChatMessage[] {
  const normalized: ChatMessage[] = [];
  let sawHiddenAssistantSinceLastVisibleMessage = false;

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }

    const role = (message as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    const content = normalizeGatewayText(extractGatewayVisibleText(message));
    if (!content) {
      if (role === "assistant") {
        sawHiddenAssistantSinceLastVisibleMessage = true;
      }
      continue;
    }

    const nextMessage: ChatMessage = { role, content };
    const previous = normalized.at(-1);

    if (
      role === "user" &&
      previous?.role === "user" &&
      sawHiddenAssistantSinceLastVisibleMessage &&
      sameChatMessage(previous, nextMessage)
    ) {
      sawHiddenAssistantSinceLastVisibleMessage = false;
      continue;
    }

    normalized.push(nextMessage);
    sawHiddenAssistantSinceLastVisibleMessage = false;
  }

  return normalized;
}
