import type { CompleteAttachment } from "@assistant-ui/react";

export type SessionStatus = "ACTIVE" | "ARCHIVED";
export type OpenClawVerboseLevel = "off" | "on" | "full";
export type OpenClawQueueMode = "collect" | "followup" | "steer";

export interface Session {
  id: string;
  client_id: string;
  gateway_session_key: string;
  name: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
}

export interface MessageAttachmentMeta {
  id: string;
  type: "image" | "document" | "file";
  name: string;
  content_type: string;
  size_bytes?: number | null;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  status: "running" | "done";
  count?: number;
}

export type AgentMessagePart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCall: ToolCall };

export interface ChatMessage {
  id?: string;
  ordinal?: number;
  role: "user" | "assistant" | "system";
  content: string;
  attachments?: MessageAttachmentMeta[];
  renderParts?: AgentMessagePart[];
  createdAt?: string;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  parts: AgentMessagePart[];
  attachments?: CompleteAttachment[];
  timestamp: number;
  status: "streaming" | "complete" | "error";
}

export interface GatewayChatAttachment {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content?: string;
}

export interface OpenClawChatCapabilities {
  gatewayReady: boolean;
  gatewayReason: string | null;
  chatModelId: string | null;
  sandbox: {
    enabled: boolean;
    type: string | null;
  };
  webSearch: {
    available: boolean;
    provider: string | null;
    reason: string | null;
  };
  pricing: {
    configured: boolean;
    model: string | null;
  };
}

export interface AgentChatHistoryResponse {
  messages?: unknown[];
  sessionKey?: string;
  webSearchEnabled?: boolean;
  verboseLevel?: OpenClawVerboseLevel;
  queueMode?: OpenClawQueueMode;
}
