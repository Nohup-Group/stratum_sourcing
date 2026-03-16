import type { ChatMessage, MessageAttachmentMeta } from "./types";

const SESSION_OUTBOX_STORAGE_KEY = "openclaw-session-outbox-v1";

export type SessionOutboxState =
  | "queued"
  | "sending"
  | "sent_to_gateway"
  | "confirmed"
  | "failed";

export interface SessionOutboxAttachment extends MessageAttachmentMeta {
  data_base64?: string;
}

export interface SessionOutboxItem {
  client_message_id: string;
  session_id: string;
  text: string;
  attachments: SessionOutboxAttachment[];
  created_at: number;
  state: SessionOutboxState;
  attempt_count: number;
  last_attempt_at?: number;
  sent_to_gateway_at?: number;
}

type SessionOutboxStore = Record<string, SessionOutboxItem[]>;

function loadStore(): SessionOutboxStore {
  try {
    const raw = localStorage.getItem(SESSION_OUTBOX_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as SessionOutboxStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveStore(store: SessionOutboxStore): void {
  localStorage.setItem(SESSION_OUTBOX_STORAGE_KEY, JSON.stringify(store));
}

function normalizeText(value: string): string {
  return value.trim();
}

function normalizeAttachmentSignature(attachments: MessageAttachmentMeta[] | undefined): string[] {
  return (attachments ?? [])
    .map((attachment) =>
      [
        attachment.type,
        attachment.name.trim().toLowerCase(),
        attachment.content_type.trim().toLowerCase(),
      ].join("|"),
    )
    .sort();
}

export function listSessionOutbox(sessionId: string | null | undefined): SessionOutboxItem[] {
  if (!sessionId) {
    return [];
  }
  const store = loadStore();
  return [...(store[sessionId] ?? [])].sort((a, b) => a.created_at - b.created_at);
}

export function upsertSessionOutboxItem(item: SessionOutboxItem): SessionOutboxItem[] {
  const store = loadStore();
  const current = store[item.session_id] ?? [];
  const next = current.filter(
    (entry) => entry.client_message_id !== item.client_message_id,
  );
  next.push(item);
  next.sort((a, b) => a.created_at - b.created_at);
  store[item.session_id] = next;
  saveStore(store);
  return next;
}

export function patchSessionOutboxItem(
  sessionId: string,
  clientMessageId: string,
  updater: (item: SessionOutboxItem) => SessionOutboxItem | null,
): SessionOutboxItem[] {
  const store = loadStore();
  const current = store[sessionId] ?? [];
  const next = current
    .map((item) => {
      if (item.client_message_id !== clientMessageId) {
        return item;
      }
      return updater(item);
    })
    .filter((item): item is SessionOutboxItem => item !== null)
    .sort((a, b) => a.created_at - b.created_at);
  if (next.length > 0) {
    store[sessionId] = next;
  } else {
    delete store[sessionId];
  }
  saveStore(store);
  return next;
}

export function confirmSessionOutbox(
  sessionId: string,
  messages: ChatMessage[],
): SessionOutboxItem[] {
  const store = loadStore();
  const current = store[sessionId] ?? [];
  if (current.length === 0) {
    return [];
  }

  const remaining = current.filter((item) => {
    const wantedText = normalizeText(item.text);
    const wantedAttachments = normalizeAttachmentSignature(item.attachments);
    const matched = messages.some((message) => {
      if (message.role !== "user") {
        return false;
      }
      if (normalizeText(message.content) !== wantedText) {
        return false;
      }
      if (
        message.createdAt &&
        Date.parse(message.createdAt) + 5_000 < item.created_at
      ) {
        return false;
      }
      const candidateAttachments = normalizeAttachmentSignature(message.attachments);
      return JSON.stringify(candidateAttachments) === JSON.stringify(wantedAttachments);
    });
    return !matched;
  });

  if (remaining.length > 0) {
    store[sessionId] = remaining;
  } else {
    delete store[sessionId];
  }
  saveStore(store);
  return remaining;
}

export function listRenderableOutboxMessages(
  sessionId: string | null | undefined,
): ChatMessage[] {
  return listSessionOutbox(sessionId)
    .filter((item) => item.state !== "failed" && item.state !== "confirmed")
    .map((item) => ({
      id: item.client_message_id,
      role: "user",
      content: item.text,
      attachments: item.attachments,
      createdAt: new Date(item.created_at).toISOString(),
    }));
}
