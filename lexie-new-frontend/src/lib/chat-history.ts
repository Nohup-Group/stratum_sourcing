import type { ChatMessage, MessageAttachmentMeta } from "./types";

function normalizeAttachments(
  attachments: MessageAttachmentMeta[] | undefined,
): string {
  if (!attachments?.length) {
    return "";
  }

  return JSON.stringify(
    attachments.map((attachment) => ({
      id: attachment.id,
      type: attachment.type,
      name: attachment.name,
      content_type: attachment.content_type,
      size_bytes: attachment.size_bytes ?? null,
    })),
  );
}

export function sameChatMessage(left: ChatMessage, right: ChatMessage): boolean {
  return (
    left.role === right.role &&
    left.content === right.content &&
    normalizeAttachments(left.attachments) ===
      normalizeAttachments(right.attachments)
  );
}

export function sameChatHistory(
  left: ChatMessage[],
  right: ChatMessage[],
): boolean {
  return (
    left.length === right.length &&
    left.every((message, index) => sameChatMessage(message, right[index]))
  );
}

export function getMissingHistoryTail(
  prefix: ChatMessage[],
  full: ChatMessage[],
): ChatMessage[] | null {
  if (prefix.length > full.length) {
    return null;
  }

  for (let index = 0; index < prefix.length; index += 1) {
    if (!sameChatMessage(prefix[index], full[index])) {
      return null;
    }
  }

  return full.slice(prefix.length);
}

export type ChatHistorySyncAction = "hydrate" | "append" | "keep" | "replace";

export function resolveChatHistorySync(params: {
  sessionChanged: boolean;
  runtimeMessages: ChatMessage[];
  persistedMessages: ChatMessage[];
}): ChatHistorySyncAction {
  const { sessionChanged, runtimeMessages, persistedMessages } = params;

  if (sessionChanged || runtimeMessages.length === 0) {
    return "hydrate";
  }

  if (sameChatHistory(runtimeMessages, persistedMessages)) {
    return "keep";
  }

  if (getMissingHistoryTail(runtimeMessages, persistedMessages)) {
    return "append";
  }

  if (getMissingHistoryTail(persistedMessages, runtimeMessages)) {
    return "keep";
  }

  return "replace";
}
