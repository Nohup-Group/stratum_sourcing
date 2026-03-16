import { useCallback, useEffect, useRef, useState } from "react";
import type { CompleteAttachment } from "@assistant-ui/react";
import { getGatewayClient } from "@/lib/openclaw-gateway";
import {
  abortAgentChat,
  fetchAgentChatHistory,
  streamAgentChat,
} from "@/lib/api";
import { getMissingHistoryTail } from "@/lib/chat-history";
import { normalizeGatewayConversation } from "@/lib/gateway-history";
import {
  clearSessionLiveRun,
  readSessionLiveRun,
  writeSessionLiveRun,
} from "@/lib/session-live-run";
import type {
  AgentMessage,
  ChatMessage,
  GatewayChatAttachment,
  MessageAttachmentMeta,
} from "@/lib/types";
import { generateId } from "@/lib/utils";

type ChatEventPayload = {
  runId?: string;
  sessionKey?: string;
  state?: "delta" | "final" | "error";
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    text?: string;
  };
  errorMessage?: string;
};

type AgentEventPayload = {
  runId?: string;
  sessionKey?: string;
  stream?: string;
  data?: Record<string, unknown>;
};

type ToolEventPhase = "start" | "update" | "result" | "error" | "end";

type ToolGroupState = {
  groupId: string;
  toolName: string;
  count: number;
  args: Record<string, unknown>;
  result?: string;
  activeCallIds: Set<string>;
};

type ActiveRun = {
  origin: "local" | "reattached";
  assistantId: string;
  runId: string;
  sessionKey: string;
  phase: "streaming" | "settling";
  messageStatus: AgentMessage["status"];
  parts: AgentMessage["parts"];
  timestamp: number;
  handoffCompleted: boolean;
  authoritativeSyncDeadlineMs: number | null;
  recoveryBaseline: ChatMessage[];
  assistantText: string;
  cancelled: boolean;
  recovering: boolean;
  pendingRecovery: boolean;
  awaitingAuthoritativeSync: boolean;
  hiddenToolCallIds: Set<string>;
  toolGroupsByKey: Map<string, ToolGroupState>;
  toolGroupKeyByCallId: Map<string, string>;
  abortController?: AbortController;
};

type GatewayAwareError = Error & {
  sentToGateway?: boolean;
};

const AUTHORITATIVE_SETTLE_TIMEOUT_MS = 3_000;

function toRuntimeAttachments(
  attachments: MessageAttachmentMeta[] | undefined,
): CompleteAttachment[] | undefined {
  if (!attachments?.length) {
    return undefined;
  }
  return attachments.map((attachment) => ({
    id: attachment.id,
    type: attachment.type,
    name: attachment.name,
    contentType: attachment.content_type,
    status: { type: "complete" as const },
    content: [],
  }));
}

const CONNECTION_STATUS_MESSAGE =
  "Connection interrupted. Reconnecting automatically.";
const GATEWAY_STARTING_MESSAGE =
  "Der Agent startet noch. Bitte in ein paar Sekunden erneut versuchen.";
const OVERLOAD_REQUEST_MESSAGE =
  "Der KI-Dienst ist derzeit überlastet. Bitte gleich erneut versuchen.";
const OVERLOAD_RECOVERY_MESSAGE =
  "Azure braucht gerade länger als üblich. Es wird automatisch weiter versucht.";
const WEB_SEARCH_UNAVAILABLE_MESSAGE =
  "Web-Recherche ist derzeit nicht konfiguriert.";
const REQUEST_ERROR_MESSAGE =
  "The request could not be completed right now.";

function isRecoverableRequestErrorMessage(raw: string): boolean {
  return /temporarily overloaded|service is temporarily overloaded|overloaded|failovererror/i.test(
    raw.trim(),
  );
}

function classifyUserFacingErrorMessage(raw: string): string {
  const message = raw.trim();
  if (!message) {
    return REQUEST_ERROR_MESSAGE;
  }
  if (isRecoverableRequestErrorMessage(message)) {
    return OVERLOAD_REQUEST_MESSAGE;
  }
  if (
    /web_search.+api key|missing_(?:perplexity|xai|gemini|kimi|brave)_api_key|needs an? .*api key/i.test(
      message,
    )
  ) {
    return WEB_SEARCH_UNAVAILABLE_MESSAGE;
  }
  if (
    /not connected|connection failed|challenge timed out|gateway closed|closed \(/i.test(
      message,
    )
  ) {
    return GATEWAY_STARTING_MESSAGE;
  }
  return REQUEST_ERROR_MESSAGE;
}

function extractToolArgs(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!data) {
    return {};
  }

  const nextArgs =
    data.args && typeof data.args === "object" && !Array.isArray(data.args)
      ? { ...(data.args as Record<string, unknown>) }
      : {};

  if (typeof data.meta === "string" && data.meta.trim()) {
    nextArgs._meta = data.meta.trim();
  }

  return nextArgs;
}

function shouldDisplayToolCall(toolName: string): boolean {
  // Surface tool activity by default so the thread shows visible progress
  // even when the agent is mostly working through CLI tools like exec/bash.
  return toolName.trim().length > 0;
}

function extractTextFromMessage(message: ChatEventPayload["message"]): string {
  if (!message) {
    return "";
  }
  if (typeof message.text === "string") {
    return message.text;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("");
}

function normalizeHistoryConversation(messages: unknown[]): ChatMessage[] {
  return normalizeGatewayConversation(messages);
}

function extractRecoveredAssistantText(params: {
  baselineMessages: ChatMessage[];
  historyMessages: unknown[];
}): string {
  const conversationHistory = normalizeHistoryConversation(
    params.historyMessages,
  );
  const missingTail = getMissingHistoryTail(
    params.baselineMessages,
    conversationHistory,
  );
  if (!missingTail?.length) {
    return "";
  }

  for (let index = missingTail.length - 1; index >= 0; index -= 1) {
    const entry = missingTail[index];
    if (entry.role === "assistant" && entry.content.trim()) {
      return entry.content;
    }
  }

  return "";
}

function extractToolResultText(value: unknown): string | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  const record = value as { content?: unknown };
  if (!Array.isArray(record.content)) {
    return undefined;
  }
  const text = record.content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const block = part as { type?: unknown; text?: unknown };
      return block.type === "text" && typeof block.text === "string"
        ? block.text
        : "";
    })
    .join("\n")
    .trim();
  return text || undefined;
}

function normalizeToolGroupKey(toolName: string): string {
  const normalized = toolName.trim().toLowerCase();
  return normalized || "tool";
}

function upsertGroupedToolCallPart(params: {
  message: AgentMessage;
  group: ToolGroupState;
  status: "running" | "done";
}): AgentMessage {
  const toolParts = params.message.parts.filter(
    (
      part,
    ): part is Extract<AgentMessage["parts"][number], { type: "tool-call" }> =>
      part.type === "tool-call",
  );
  const textParts = params.message.parts.filter(
    (part): part is Extract<AgentMessage["parts"][number], { type: "text" }> =>
      part.type === "text",
  );

  const nextToolCall = {
    id: params.group.groupId,
    name: params.group.toolName,
    args: { ...params.group.args, count: params.group.count },
    status: params.status,
    count: params.group.count,
    result: params.group.result,
  } as const;

  let matched = false;
  const nextToolParts = toolParts.map((part) => {
    if (part.toolCall.id !== params.group.groupId) {
      return part;
    }
    matched = true;
    return {
      type: "tool-call" as const,
      toolCall: nextToolCall,
    };
  });

  if (!matched) {
    nextToolParts.push({
      type: "tool-call",
      toolCall: nextToolCall,
    });
  }

  return {
    ...params.message,
    parts: orderAssistantParts([...nextToolParts, ...textParts]),
  };
}

function getUserFacingConnectionError(): string {
  return CONNECTION_STATUS_MESSAGE;
}

function getUserFacingRequestError(error?: unknown): string {
  if (error instanceof Error) {
    return classifyUserFacingErrorMessage(error.message);
  }
  if (typeof error === "string") {
    return classifyUserFacingErrorMessage(error);
  }
  return REQUEST_ERROR_MESSAGE;
}

function isRecoverableRequestError(error?: unknown): boolean {
  if (error instanceof Error) {
    return isRecoverableRequestErrorMessage(error.message);
  }
  if (typeof error === "string") {
    return isRecoverableRequestErrorMessage(error);
  }
  return false;
}

function orderAssistantParts(
  parts: AgentMessage["parts"],
): AgentMessage["parts"] {
  const toolParts = parts.filter(
    (
      part,
    ): part is Extract<AgentMessage["parts"][number], { type: "tool-call" }> =>
      part.type === "tool-call",
  );
  const textParts = parts.filter(
    (part): part is Extract<AgentMessage["parts"][number], { type: "text" }> =>
      part.type === "text",
  );
  return [...toolParts, ...textParts];
}

function getToolCallParts(
  parts: AgentMessage["parts"],
): Extract<AgentMessage["parts"][number], { type: "tool-call" }>[] {
  return parts.filter(
    (
      part,
    ): part is Extract<AgentMessage["parts"][number], { type: "tool-call" }> =>
      part.type === "tool-call",
  );
}

function getTextParts(
  parts: AgentMessage["parts"],
): Extract<AgentMessage["parts"][number], { type: "text" }>[] {
  return parts.filter(
    (part): part is Extract<AgentMessage["parts"][number], { type: "text" }> =>
      part.type === "text",
  );
}

function hasToolCallParts(parts: AgentMessage["parts"]): boolean {
  return getToolCallParts(parts).length > 0;
}

function hasVisibleTextParts(parts: AgentMessage["parts"]): boolean {
  return getTextParts(parts).some((part) => part.text.trim().length > 0);
}

function resolveHistoryMessageId(message: ChatMessage, index: number): string {
  if (message.id?.trim()) {
    return message.id;
  }
  if (typeof message.ordinal === "number") {
    return `history-${message.role}-${message.ordinal}`;
  }
  return `history-${message.role}-${index}`;
}

function resolveHistoryMessageTimestamp(message: ChatMessage): number {
  if (message.createdAt) {
    const parsed = Date.parse(message.createdAt);
    if (!Number.isNaN(parsed)) {
      return parsed / 1000;
    }
  }
  return Date.now() / 1000;
}

function extractTextFromAgentMessage(message: AgentMessage): string {
  return message.parts
    .filter(
      (
        part,
      ): part is Extract<AgentMessage["parts"][number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

function normalizeHistoryRenderParts(
  message: ChatMessage,
): AgentMessage["parts"] {
  const renderParts = Array.isArray(message.renderParts)
    ? message.renderParts
    : [];
  const nextParts: AgentMessage["parts"] = [];

  for (const part of renderParts) {
    if (!part || typeof part !== "object") {
      continue;
    }
    if (part.type === "text" && typeof part.text === "string") {
      nextParts.push({ type: "text", text: part.text });
      continue;
    }
    if (
      part.type === "tool-call" &&
      part.toolCall &&
      typeof part.toolCall === "object"
    ) {
      const toolCall = part.toolCall;
      const rawArgs =
        toolCall.args &&
        typeof toolCall.args === "object" &&
        !Array.isArray(toolCall.args)
          ? (toolCall.args as Record<string, unknown>)
          : {};
      const count =
        typeof toolCall.count === "number"
          ? toolCall.count
          : typeof rawArgs.count === "number"
            ? rawArgs.count
            : undefined;
      nextParts.push({
        type: "tool-call",
        toolCall: {
          id:
            typeof toolCall.id === "string" && toolCall.id.trim()
              ? toolCall.id
              : `history-tool:${typeof toolCall.name === "string" ? toolCall.name : "tool"}`,
          name:
            typeof toolCall.name === "string" && toolCall.name.trim()
              ? toolCall.name
              : "tool",
          args: rawArgs,
          result:
            typeof toolCall.result === "string" ? toolCall.result : undefined,
          status: toolCall.status === "running" ? "running" : "done",
          count,
        },
      });
    }
  }

  if (nextParts.length > 0) {
    return orderAssistantParts(nextParts);
  }
  if (message.content) {
    return [{ type: "text", text: message.content }];
  }
  return [];
}

function buildRenderableSignature(parts: AgentMessage["parts"]): string {
  return JSON.stringify(
    parts.map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : {
            type: "tool-call",
            id: part.toolCall.id,
            name: part.toolCall.name,
            args: part.toolCall.args,
            result: part.toolCall.result,
            status: part.toolCall.status,
            count: part.toolCall.count,
          },
    ),
  );
}

function hydrateAgentMessageFromHistory(
  message: ChatMessage,
  index: number,
): AgentMessage {
  return {
    id: resolveHistoryMessageId(message, index),
    role: message.role as "user" | "assistant",
    parts: normalizeHistoryRenderParts(message),
    attachments:
      message.role === "user"
        ? toRuntimeAttachments(message.attachments)
        : undefined,
    timestamp: resolveHistoryMessageTimestamp(message),
    status: "complete",
  };
}

function mergeAssistantPartsFromHistory(
  currentParts: AgentMessage["parts"],
  historyMessage: ChatMessage,
): AgentMessage["parts"] {
  const historyParts = normalizeHistoryRenderParts(historyMessage);
  if (historyParts.length === 0) {
    return currentParts;
  }

  const historyToolParts = getToolCallParts(historyParts);
  const historyTextParts = getTextParts(historyParts);
  if (historyToolParts.length > 0) {
    if (historyTextParts.length > 0) {
      return orderAssistantParts(historyParts);
    }

    const currentToolParts = getToolCallParts(currentParts);
    const mergedToolParts = historyToolParts.map((historyPart) => {
      const currentPart = currentToolParts.find(
        (part) => part.toolCall.id === historyPart.toolCall.id,
      );
      return currentPart ?? historyPart;
    });
    const mergedToolIds = new Set(
      mergedToolParts.map((part) => part.toolCall.id),
    );

    for (const currentPart of currentToolParts) {
      if (!mergedToolIds.has(currentPart.toolCall.id)) {
        mergedToolParts.push(currentPart);
      }
    }

    return orderAssistantParts([...mergedToolParts, ...getTextParts(currentParts)]);
  }

  return orderAssistantParts([...getToolCallParts(currentParts), ...historyTextParts]);
}

function sameAgentAndChatMessage(
  agentMessage: AgentMessage,
  chatMessage: ChatMessage,
): boolean {
  const historyParts = normalizeHistoryRenderParts(chatMessage);
  return (
    agentMessage.role === chatMessage.role &&
    extractTextFromAgentMessage(agentMessage) === chatMessage.content &&
    buildRenderableSignature(agentMessage.parts) ===
      buildRenderableSignature(historyParts)
  );
}

function hasMatchingTrailingAssistantMessage(
  messages: AgentMessage[],
  assistantText: string,
): boolean {
  const expected = assistantText.trim();
  if (!expected) {
    return false;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") {
      return false;
    }
    return extractTextFromAgentMessage(message).trim() === expected;
  }
  return false;
}

function shouldMergeActiveRunIntoTrailingHistoryAssistant(
  activeRun: ActiveRun,
  historyMessage: ChatMessage,
): boolean {
  if (historyMessage.role !== "assistant") {
    return false;
  }

  const historyParts = normalizeHistoryRenderParts(historyMessage);
  return (
    hasToolCallParts(activeRun.parts) &&
    hasToolCallParts(historyParts) &&
    !hasVisibleTextParts(historyParts)
  );
}

function normalizeComparableChatText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function findAuthoritativeAssistantTail(params: {
  baselineMessages: ChatMessage[];
  historyMessages: ChatMessage[];
  assistantText: string;
}): { message: ChatMessage; index: number } | null {
  const expected = normalizeComparableChatText(params.assistantText);
  if (!expected) {
    return null;
  }

  const missingTail = getMissingHistoryTail(
    params.baselineMessages,
    params.historyMessages,
  );
  if (!missingTail?.length) {
    return null;
  }

  for (let index = params.historyMessages.length - 1; index >= 0; index -= 1) {
    const message = params.historyMessages[index];
    if (!missingTail.includes(message)) {
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }
    if (normalizeComparableChatText(message.content) !== expected) {
      continue;
    }
    return { message, index };
  }

  return null;
}

export function useMessages(params: {
  gatewayEnabled: boolean;
  transport: "gateway" | "http";
  activeSessionKey?: string | null;
  activeSessionHistory?: ChatMessage[];
  activeSessionHistoryLoaded?: boolean;
  activeSessionMessageCount?: number;
  requestAuthoritativeSessionRefresh?: (sessionKey: string) => Promise<unknown>;
}) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [runningSessionKeys, setRunningSessionKeys] = useState<string[]>([]);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const activeRunsRef = useRef<Map<string, ActiveRun>>(new Map());
  const messagesRef = useRef<AgentMessage[]>([]);
  const activeSessionKeyRef = useRef<string | null>(
    params.activeSessionKey ?? null,
  );

  useEffect(() => {
    activeSessionKeyRef.current = params.activeSessionKey ?? null;
  }, [params.activeSessionKey]);

  const getActiveRun = useCallback(
    (sessionKey?: string | null): ActiveRun | null => {
      if (!sessionKey) {
        return null;
      }
      return activeRunsRef.current.get(sessionKey) ?? null;
    },
    [],
  );

  const syncRunningSessions = useCallback(() => {
    setRunningSessionKeys(
      Array.from(activeRunsRef.current.values())
        .filter(
          (activeRun) =>
            !activeRun.handoffCompleted && activeRun.phase === "streaming",
        )
        .map((activeRun) => activeRun.sessionKey),
    );
  }, []);

  const isSessionStreaming = useCallback(
    (sessionKey?: string | null): boolean => {
      const activeRun = getActiveRun(sessionKey);
      return Boolean(
        activeRun &&
        !activeRun.handoffCompleted &&
        activeRun.phase === "streaming",
      );
    },
    [getActiveRun],
  );

  const buildActiveRunMessage = useCallback(
    (activeRun: ActiveRun): AgentMessage => ({
      id: activeRun.assistantId,
      role: "assistant",
      parts: activeRun.parts,
      timestamp: activeRun.timestamp,
      status: activeRun.messageStatus,
    }),
    [],
  );

  const buildMessagesFromHistory = useCallback(
    (
      chatMessages: ChatMessage[],
      activeRun?: ActiveRun | null,
    ): AgentMessage[] => {
      const agentMessages = chatMessages
        .filter(
          (message) => message.role === "user" || message.role === "assistant",
        )
        .map(hydrateAgentMessageFromHistory);
      if (!activeRun) {
        return agentMessages;
      }

      const activeRunMessage = buildActiveRunMessage(activeRun);
      const trailingHistoryMessage = chatMessages[chatMessages.length - 1];
      if (
        !trailingHistoryMessage ||
        trailingHistoryMessage.role !== "assistant"
      ) {
        return [...agentMessages, activeRunMessage];
      }

      if (
        !hasMatchingTrailingAssistantMessage(
          agentMessages,
          activeRun.assistantText,
        ) &&
        !shouldMergeActiveRunIntoTrailingHistoryAssistant(
          activeRun,
          trailingHistoryMessage,
        )
      ) {
        return [...agentMessages, activeRunMessage];
      }

      return [
        ...agentMessages.slice(0, -1),
        {
          ...activeRunMessage,
          parts: mergeAssistantPartsFromHistory(
            activeRun.parts,
            trailingHistoryMessage,
          ),
          timestamp: resolveHistoryMessageTimestamp(trailingHistoryMessage),
        },
      ];
    },
    [buildActiveRunMessage],
  );

  const syncRenderedActiveRun = useCallback(
    (
      activeRun: ActiveRun | null | undefined,
      options?: { appendIfMissing?: boolean; matchMessageId?: string },
    ) => {
      if (
        !activeRun ||
        activeRun.handoffCompleted ||
        (activeSessionKeyRef.current &&
          activeSessionKeyRef.current !== activeRun.sessionKey)
      ) {
        return;
      }

      const nextMessage = buildActiveRunMessage(activeRun);
      setMessages((previous) => {
        const existingIndex = previous.findIndex(
          (message) =>
            message.id === activeRun.assistantId ||
            (options?.matchMessageId
              ? message.id === options.matchMessageId
              : false),
        );
        if (existingIndex >= 0) {
          const next = [...previous];
          next[existingIndex] = nextMessage;
          return next;
        }
        if (options?.appendIfMissing === false) {
          return previous;
        }
        return [...previous, nextMessage];
      });
    },
    [buildActiveRunMessage],
  );

  const persistActiveRunSnapshot = useCallback(
    (activeRun: ActiveRun | null | undefined) => {
      if (!activeRun) {
        return;
      }
      writeSessionLiveRun({
        sessionKey: activeRun.sessionKey,
        runId: activeRun.runId,
        assistantText: activeRun.assistantText,
        parts: activeRun.parts,
        updatedAt: Date.now(),
      });
    },
    [],
  );

  const clearActiveRun = useCallback(
    (
      activeRun: ActiveRun | null | undefined,
      options?: { clearSnapshot?: boolean },
    ) => {
      if (!activeRun) {
        return;
      }
      activeRun.handoffCompleted = true;
      const stored = activeRunsRef.current.get(activeRun.sessionKey);
      if (stored === activeRun) {
        activeRunsRef.current.delete(activeRun.sessionKey);
      }
      if (options?.clearSnapshot !== false) {
        clearSessionLiveRun(activeRun.sessionKey);
      }
      syncRunningSessions();
    },
    [syncRunningSessions],
  );

  const enterSettlingPhase = useCallback(
    (activeRun: ActiveRun | null | undefined) => {
      if (!activeRun || activeRun.handoffCompleted) {
        return;
      }
      activeRun.phase = "settling";
      activeRun.awaitingAuthoritativeSync = true;
      activeRun.authoritativeSyncDeadlineMs =
        Date.now() + AUTHORITATIVE_SETTLE_TIMEOUT_MS;
      syncRunningSessions();
      syncRenderedActiveRun(activeRun, { appendIfMissing: true });
      persistActiveRunSnapshot(activeRun);
    },
    [persistActiveRunSnapshot, syncRenderedActiveRun, syncRunningSessions],
  );

  const updateActiveRunMessage = useCallback(
    (
      activeRun: ActiveRun | null | undefined,
      updater: (message: AgentMessage) => AgentMessage,
    ) => {
      if (!activeRun || activeRun.handoffCompleted) {
        return;
      }

      const nextMessage = updater(buildActiveRunMessage(activeRun));
      activeRun.assistantId = nextMessage.id;
      activeRun.parts = nextMessage.parts;
      activeRun.timestamp = nextMessage.timestamp;
      activeRun.messageStatus = nextMessage.status;
      activeRun.assistantText = extractTextFromAgentMessage(nextMessage);
      syncRenderedActiveRun(activeRun, { appendIfMissing: true });
      persistActiveRunSnapshot(activeRun);
    },
    [buildActiveRunMessage, persistActiveRunSnapshot, syncRenderedActiveRun],
  );

  const setAssistantText = useCallback(
    (
      activeRun: ActiveRun | null | undefined,
      text: string,
      clearToolParts = false,
    ) => {
      updateActiveRunMessage(activeRun, (message) => {
        const toolParts = clearToolParts
          ? []
          : message.parts.filter((part) => part.type === "tool-call");
        const nextParts = orderAssistantParts(
          text.trim().length > 0
            ? [...toolParts, { type: "text" as const, text }]
            : toolParts,
        );
        return {
          ...message,
          parts: nextParts,
        };
      });
    },
    [updateActiveRunMessage],
  );

  const markAssistantComplete = useCallback(
    (activeRun: ActiveRun | null | undefined) => {
      updateActiveRunMessage(activeRun, (message) => ({
        ...message,
        status: "complete",
      }));
    },
    [updateActiveRunMessage],
  );

  const markAssistantError = useCallback(
    (activeRun: ActiveRun | null | undefined, errorMessage: string) => {
      updateActiveRunMessage(activeRun, (message) => {
        const parts =
          message.parts.length > 0
            ? message.parts
            : [{ type: "text" as const, text: `Error: ${errorMessage}` }];
        return {
          ...message,
          parts,
          status: "error",
        };
      });
    },
    [updateActiveRunMessage],
  );

  const adoptSettledRunFromHistory = useCallback(
    (activeRun: ActiveRun, historyMessages: ChatMessage[]): boolean => {
      const authoritativeTail = findAuthoritativeAssistantTail({
        baselineMessages: activeRun.recoveryBaseline,
        historyMessages,
        assistantText: activeRun.assistantText,
      });
      if (!authoritativeTail) {
        return false;
      }

      const previousAssistantId = activeRun.assistantId;
      activeRun.assistantId = resolveHistoryMessageId(
        authoritativeTail.message,
        authoritativeTail.index,
      );
      activeRun.timestamp = resolveHistoryMessageTimestamp(
        authoritativeTail.message,
      );
      activeRun.parts = mergeAssistantPartsFromHistory(
        activeRun.parts,
        authoritativeTail.message,
      );
      activeRun.messageStatus = "complete";
      activeRun.assistantText = extractTextFromAgentMessage(
        buildActiveRunMessage(activeRun),
      );
      syncRenderedActiveRun(activeRun, {
        appendIfMissing: true,
        matchMessageId: previousAssistantId,
      });
      activeRun.awaitingAuthoritativeSync = false;
      clearActiveRun(activeRun);
      return true;
    },
    [buildActiveRunMessage, clearActiveRun, syncRenderedActiveRun],
  );

  const startActiveRun = useCallback(
    (params: {
      origin: "local" | "reattached";
      runId: string;
      sessionKey: string;
      recoveryBaseline: ChatMessage[];
      assistantText?: string;
      initialParts?: AgentMessage["parts"];
    }): ActiveRun => {
      const existing = activeRunsRef.current.get(params.sessionKey);
      if (existing && !existing.handoffCompleted) {
        clearActiveRun(existing, { clearSnapshot: false });
      }
      const assistantId = generateId();
      const assistantText = params.assistantText ?? "";
      const initialParts =
        params.initialParts ??
        (assistantText.trim()
          ? [{ type: "text" as const, text: assistantText }]
          : []);
      const timestamp = Date.now() / 1000;
      setConnectionError(null);

      const activeRun: ActiveRun = {
        origin: params.origin,
        assistantId,
        runId: params.runId,
        sessionKey: params.sessionKey,
        phase: "streaming",
        messageStatus: "streaming",
        parts: initialParts,
        timestamp,
        handoffCompleted: false,
        authoritativeSyncDeadlineMs: null,
        recoveryBaseline: params.recoveryBaseline,
        assistantText,
        cancelled: false,
        recovering: false,
        pendingRecovery: false,
        awaitingAuthoritativeSync: false,
        hiddenToolCallIds: new Set<string>(),
        toolGroupsByKey: new Map<string, ToolGroupState>(),
        toolGroupKeyByCallId: new Map<string, string>(),
      };
      activeRunsRef.current.set(params.sessionKey, activeRun);
      syncRunningSessions();
      syncRenderedActiveRun(activeRun);
      persistActiveRunSnapshot(activeRun);

      return activeRun;
    },
    [
      clearActiveRun,
      persistActiveRunSnapshot,
      syncRenderedActiveRun,
      syncRunningSessions,
    ],
  );

  const ensureReattachedRun = useCallback(
    (params: {
      sessionKey: string;
      runId?: string;
      recoveryBaseline: ChatMessage[];
      assistantText?: string;
      initialParts?: AgentMessage["parts"];
    }): ActiveRun => {
      const existing = getActiveRun(params.sessionKey);
      if (existing) {
        if (params.runId?.trim()) {
          existing.runId = params.runId.trim();
        }
        if (params.assistantText?.trim()) {
          existing.assistantText = params.assistantText;
          setAssistantText(existing, params.assistantText);
        } else if (params.initialParts?.length) {
          existing.parts = params.initialParts;
          syncRenderedActiveRun(existing, { appendIfMissing: true });
        }
        persistActiveRunSnapshot(existing);
        return existing;
      }

      return startActiveRun({
        origin: "reattached",
        runId: params.runId?.trim() || `reattach:${params.sessionKey}`,
        sessionKey: params.sessionKey,
        recoveryBaseline: params.recoveryBaseline,
        assistantText: params.assistantText,
        initialParts: params.initialParts,
      });
    },
    [
      getActiveRun,
      persistActiveRunSnapshot,
      setAssistantText,
      startActiveRun,
      syncRenderedActiveRun,
    ],
  );

  useEffect(() => {
    messagesRef.current = messages;
    const activeRun = getActiveRun(params.activeSessionKey);
    if (activeRun) {
      persistActiveRunSnapshot(activeRun);
    }
  }, [
    getActiveRun,
    messages,
    params.activeSessionKey,
    persistActiveRunSnapshot,
  ]);

  const applyToolEvent = useCallback(
    (params: {
      activeRun: ActiveRun;
      phase: ToolEventPhase;
      toolCallId: string;
      toolName: string;
      toolArgs: Record<string, unknown>;
      resultText?: string;
    }) => {
      const groupKey =
        params.activeRun.toolGroupKeyByCallId.get(params.toolCallId) ??
        normalizeToolGroupKey(params.toolName);
      let group = params.activeRun.toolGroupsByKey.get(groupKey);
      if (!group) {
        group = {
          groupId: `tool-group:${groupKey}`,
          toolName: params.toolName,
          count: 0,
          args: {},
          activeCallIds: new Set<string>(),
        };
        params.activeRun.toolGroupsByKey.set(groupKey, group);
      }

      if (!params.activeRun.toolGroupKeyByCallId.has(params.toolCallId)) {
        params.activeRun.toolGroupKeyByCallId.set(params.toolCallId, groupKey);
        group.count += 1;
      }

      group.toolName = params.toolName;
      group.args = { ...group.args, ...params.toolArgs };

      if (params.phase === "start" || params.phase === "update") {
        group.activeCallIds.add(params.toolCallId);
      } else {
        group.activeCallIds.delete(params.toolCallId);
      }

      if (params.phase !== "start" && params.resultText !== undefined) {
        group.result = params.resultText;
      }

      const status =
        params.phase === "start" ||
        params.phase === "update" ||
        group.activeCallIds.size > 0
          ? ("running" as const)
          : ("done" as const);

      updateActiveRunMessage(params.activeRun, (message) =>
        upsertGroupedToolCallPart({
          message,
          group,
          status,
        }),
      );
    },
    [updateActiveRunMessage],
  );

  const recoverActiveRun = useCallback(
    async (targetRun?: ActiveRun | null) => {
      const activeRun = targetRun ?? getActiveRun(params.activeSessionKey);
      if (!activeRun) {
        return;
      }
      if (activeRun.recovering) {
        activeRun.pendingRecovery = true;
        return;
      }
      activeRun.recovering = true;
      try {
        const history =
          params.transport === "gateway"
            ? await getGatewayClient().getChatHistory(activeRun.sessionKey)
            : await fetchAgentChatHistory(activeRun.sessionKey);
        const recoveredText = extractRecoveredAssistantText({
          baselineMessages: activeRun.recoveryBaseline,
          historyMessages: history.messages ?? [],
        });
        if (recoveredText.trim()) {
          activeRun.assistantText = recoveredText;
          setAssistantText(activeRun, recoveredText, true);
        }
        setConnectionError(null);
      } catch {
        setConnectionError(getUserFacingConnectionError());
      } finally {
        const rerun = activeRun.pendingRecovery;
        activeRun.pendingRecovery = false;
        activeRun.recovering = false;
        if (rerun) {
          void recoverActiveRun(activeRun);
        }
      }
    },
    [getActiveRun, params.activeSessionKey, params.transport, setAssistantText],
  );

  useEffect(() => {
    if (!params.activeSessionKey) {
      if (!params.activeSessionHistoryLoaded) {
        return;
      }
      if (
        (params.activeSessionMessageCount ?? 0) > 0 &&
        (params.activeSessionHistory?.length ?? 0) === 0
      ) {
        return;
      }
      setMessages(buildMessagesFromHistory(params.activeSessionHistory ?? []));
      return;
    }

    const activeRun = getActiveRun(params.activeSessionKey);
    if (!activeRun) {
      return;
    }
    setMessages(
      buildMessagesFromHistory(params.activeSessionHistory ?? [], activeRun),
    );
  }, [
    buildMessagesFromHistory,
    getActiveRun,
    params.activeSessionHistory,
    params.activeSessionHistoryLoaded,
    params.activeSessionKey,
    params.activeSessionMessageCount,
  ]);

  useEffect(() => {
    const activeRun = getActiveRun(params.activeSessionKey);
    if (
      !activeRun ||
      activeRun.phase !== "settling" ||
      activeRun.handoffCompleted ||
      !activeRun.awaitingAuthoritativeSync ||
      !params.activeSessionKey ||
      activeRun.sessionKey !== params.activeSessionKey
    ) {
      return;
    }

    if (
      !params.activeSessionHistory ||
      !adoptSettledRunFromHistory(activeRun, params.activeSessionHistory)
    ) {
      return;
    }
  }, [
    adoptSettledRunFromHistory,
    getActiveRun,
    params.activeSessionHistory,
    params.activeSessionKey,
  ]);

  useEffect(() => {
    const activeRun = getActiveRun(params.activeSessionKey);
    if (
      !activeRun ||
      activeRun.phase !== "settling" ||
      activeRun.handoffCompleted ||
      !activeRun.authoritativeSyncDeadlineMs ||
      !params.activeSessionKey ||
      activeRun.sessionKey !== params.activeSessionKey
    ) {
      return;
    }

    const timeoutMs = Math.max(
      activeRun.authoritativeSyncDeadlineMs - Date.now(),
      0,
    );
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      if (
        cancelled ||
        getActiveRun(activeRun.sessionKey) !== activeRun ||
        activeRun.handoffCompleted
      ) {
        return;
      }
      void (async () => {
        try {
          await params.requestAuthoritativeSessionRefresh?.(
            activeRun.sessionKey,
          );
          if (cancelled || getActiveRun(activeRun.sessionKey) !== activeRun) {
            return;
          }
          if (
            params.activeSessionHistory &&
            adoptSettledRunFromHistory(activeRun, params.activeSessionHistory)
          ) {
            return;
          }
        } catch {
          // Keep the completed assistant visible even if authoritative refresh fails.
        }
      })();
    }, timeoutMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [
    adoptSettledRunFromHistory,
    getActiveRun,
    messages,
    params.activeSessionHistory,
    params.activeSessionKey,
    params.requestAuthoritativeSessionRefresh,
  ]);

  useEffect(() => {
    if (
      params.transport !== "gateway" ||
      !params.gatewayEnabled ||
      !params.activeSessionKey ||
      !params.activeSessionHistoryLoaded ||
      getActiveRun(params.activeSessionKey)
    ) {
      return;
    }

    const baselineMessages = params.activeSessionHistory ?? [];
    const lastConversationMessage =
      baselineMessages.length > 0
        ? baselineMessages[baselineMessages.length - 1]
        : undefined;
    if (lastConversationMessage?.role === "assistant") {
      clearSessionLiveRun(params.activeSessionKey);
      return;
    }

    const snapshot = readSessionLiveRun(params.activeSessionKey);
    if (snapshot) {
      ensureReattachedRun({
        sessionKey: snapshot.sessionKey,
        runId: snapshot.runId,
        recoveryBaseline: baselineMessages,
        assistantText: snapshot.assistantText,
        initialParts: snapshot.parts,
      });
    }

    let cancelled = false;
    void (async () => {
      try {
        const history = await getGatewayClient().getChatHistory(
          params.activeSessionKey!,
        );
        if (cancelled) {
          return;
        }
        const recoveredText = extractRecoveredAssistantText({
          baselineMessages,
          historyMessages: history.messages ?? [],
        });
        if (!recoveredText.trim()) {
          return;
        }
        ensureReattachedRun({
          sessionKey: params.activeSessionKey!,
          recoveryBaseline: baselineMessages,
          assistantText: recoveredText,
        });
      } catch {
        // Best-effort reattachment only.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    ensureReattachedRun,
    getActiveRun,
    params.activeSessionHistory,
    params.activeSessionHistoryLoaded,
    params.activeSessionKey,
    params.gatewayEnabled,
    params.transport,
  ]);

  useEffect(() => {
    if (params.transport !== "gateway") {
      setConnectionError(null);
      return;
    }

    const gatewayClient = getGatewayClient();
    if (!params.gatewayEnabled) {
      gatewayClient.disconnect();
      setConnectionError(null);
      return;
    }

    const unsubscribeEvents = gatewayClient.subscribe((event) => {
      if (event.event === "chat") {
        const payload = (event.payload ?? {}) as ChatEventPayload;
        const payloadSessionKey =
          typeof payload.sessionKey === "string" ? payload.sessionKey : "";
        let activeRun = getActiveRun(payloadSessionKey);
        if (!activeRun) {
          if (
            !params.activeSessionKey ||
            payloadSessionKey !== params.activeSessionKey
          ) {
            return;
          }
          const incomingAssistantText =
            payload.state === "delta" || payload.state === "final"
              ? extractTextFromMessage(payload.message)
              : "";
          if (
            hasMatchingTrailingAssistantMessage(
              messagesRef.current,
              incomingAssistantText,
            )
          ) {
            return;
          }
          activeRun = ensureReattachedRun({
            sessionKey: payloadSessionKey,
            runId:
              typeof payload.runId === "string" ? payload.runId : undefined,
            recoveryBaseline: params.activeSessionHistory ?? [],
            assistantText: incomingAssistantText || undefined,
          });
        }

        if (activeRun.handoffCompleted) {
          return;
        }

        const matchesSessionScopedReattach =
          activeRun.origin === "reattached" &&
          payloadSessionKey &&
          payloadSessionKey === activeRun.sessionKey;
        if (
          payload.runId !== activeRun.runId &&
          !matchesSessionScopedReattach
        ) {
          return;
        }
        if (
          matchesSessionScopedReattach &&
          typeof payload.runId === "string" &&
          payload.runId.trim()
        ) {
          activeRun.runId = payload.runId.trim();
          persistActiveRunSnapshot(activeRun);
        }
        if (
          activeRun.phase === "settling" &&
          (payload.state === "delta" || payload.state === "final")
        ) {
          return;
        }
        if (payload.state === "delta" || payload.state === "final") {
          const nextText = extractTextFromMessage(payload.message);
          activeRun.assistantText = nextText;
          setAssistantText(activeRun, nextText);
          if (payload.state === "final") {
            markAssistantComplete(activeRun);
            enterSettlingPhase(activeRun);
          }
          return;
        }
        if (payload.state === "error") {
          if (isRecoverableRequestError(payload.errorMessage)) {
            activeRun.pendingRecovery = true;
            setConnectionError(OVERLOAD_RECOVERY_MESSAGE);
            return;
          }
          const errorMessage = getUserFacingRequestError(payload.errorMessage);
          markAssistantError(activeRun, errorMessage);
          setConnectionError(errorMessage);
          if (activeRun.origin === "reattached") {
            clearActiveRun(activeRun);
          }
        }
        return;
      }

      if (event.event !== "agent") {
        return;
      }

      const payload = (event.payload ?? {}) as AgentEventPayload;
      const payloadSessionKey =
        typeof payload.sessionKey === "string" ? payload.sessionKey : "";
      let activeRun = getActiveRun(payloadSessionKey);
      if (!activeRun) {
        if (
          !params.activeSessionKey ||
          payloadSessionKey !== params.activeSessionKey
        ) {
          return;
        }
        activeRun = ensureReattachedRun({
          sessionKey: payloadSessionKey,
          runId: typeof payload.runId === "string" ? payload.runId : undefined,
          recoveryBaseline: params.activeSessionHistory ?? [],
        });
      }
      if (activeRun.handoffCompleted || activeRun.phase === "settling") {
        return;
      }
      const matchesSessionScopedReattach =
        activeRun.origin === "reattached" &&
        payloadSessionKey &&
        payloadSessionKey === activeRun.sessionKey;
      if (
        payload.stream !== "tool" ||
        (payload.runId !== activeRun.runId && !matchesSessionScopedReattach)
      ) {
        return;
      }
      if (
        matchesSessionScopedReattach &&
        typeof payload.runId === "string" &&
        payload.runId.trim()
      ) {
        activeRun.runId = payload.runId.trim();
        persistActiveRunSnapshot(activeRun);
      }

      const phase =
        typeof payload.data?.phase === "string" ? payload.data.phase : "";
      const toolArgs = extractToolArgs(payload.data);
      const toolCallId =
        typeof payload.data?.toolCallId === "string"
          ? payload.data.toolCallId
          : "";
      const toolName =
        typeof payload.data?.name === "string" ? payload.data.name : "tool";
      if (!toolCallId) {
        return;
      }
      if (activeRun.hiddenToolCallIds.has(toolCallId)) {
        return;
      }
      if (phase === "start" && !shouldDisplayToolCall(toolName)) {
        activeRun.hiddenToolCallIds.add(toolCallId);
        return;
      }

      if (
        phase === "start" ||
        phase === "update" ||
        phase === "result" ||
        phase === "error" ||
        phase === "end"
      ) {
        const resultText =
          phase === "error"
            ? String(payload.data?.error || "Tool failed")
            : extractToolResultText(payload.data?.result);
        applyToolEvent({
          activeRun,
          phase: phase as ToolEventPhase,
          toolCallId,
          toolName,
          toolArgs,
          resultText,
        });
      }
    });

    const unsubscribeGap = gatewayClient.onGap(() => {
      for (const activeRun of activeRunsRef.current.values()) {
        void recoverActiveRun(activeRun);
      }
    });

    const unsubscribeStatus = gatewayClient.onStatusChange((connected) => {
      if (connected) {
        setConnectionError(null);
        for (const activeRun of activeRunsRef.current.values()) {
          if (!activeRun.pendingRecovery) {
            continue;
          }
          activeRun.pendingRecovery = false;
          void recoverActiveRun(activeRun);
        }
        return;
      }
      if (activeRunsRef.current.size === 0) {
        setConnectionError(getUserFacingConnectionError());
        return;
      }
      for (const activeRun of activeRunsRef.current.values()) {
        activeRun.pendingRecovery = true;
      }
      setConnectionError(getUserFacingConnectionError());
    });

    void gatewayClient.connect().catch(() => {
      setConnectionError(getUserFacingConnectionError());
    });

    return () => {
      unsubscribeEvents();
      unsubscribeGap();
      unsubscribeStatus();
    };
  }, [
    applyToolEvent,
    clearActiveRun,
    enterSettlingPhase,
    ensureReattachedRun,
    getActiveRun,
    markAssistantComplete,
    markAssistantError,
    params.activeSessionHistory,
    params.activeSessionKey,
    params.gatewayEnabled,
    params.transport,
    persistActiveRunSnapshot,
    recoverActiveRun,
    setAssistantText,
  ]);

  const clearMessages = useCallback(() => {
    if (getActiveRun(params.activeSessionKey)) {
      return;
    }
    setMessages([]);
  }, [getActiveRun, params.activeSessionKey]);

  const setMessagesFromHistory = useCallback(
    (chatMessages: ChatMessage[]) => {
      const activeRun = getActiveRun(params.activeSessionKey);
      setMessages(buildMessagesFromHistory(chatMessages, activeRun));
    },
    [buildMessagesFromHistory, getActiveRun, params.activeSessionKey],
  );

  const appendMessagesFromHistory = useCallback(
    (chatMessages: ChatMessage[]) => {
      if (getActiveRun(params.activeSessionKey) || chatMessages.length === 0) {
        return;
      }

      const agentMessages = chatMessages
        .filter(
          (message) => message.role === "user" || message.role === "assistant",
        )
        .map(hydrateAgentMessageFromHistory);

      if (agentMessages.length === 0) {
        return;
      }

      setMessages((previous) => [...previous, ...agentMessages]);
    },
    [getActiveRun, params.activeSessionKey],
  );

  const adoptMessagesFromHistory = useCallback(
    (chatMessages: ChatMessage[]) => {
      if (getActiveRun(params.activeSessionKey) || chatMessages.length === 0) {
        return;
      }

      const conversationMessages = chatMessages.filter(
        (message) => message.role === "user" || message.role === "assistant",
      );
      if (conversationMessages.length === 0) {
        return;
      }

      setMessages((previous) => {
        if (previous.length < conversationMessages.length) {
          return previous;
        }

        const startIndex = previous.length - conversationMessages.length;
        for (
          let offset = 0;
          offset < conversationMessages.length;
          offset += 1
        ) {
          if (
            !sameAgentAndChatMessage(
              previous[startIndex + offset],
              conversationMessages[offset],
            )
          ) {
            return previous;
          }
        }

        return previous.map((message, index) => {
          if (index < startIndex) {
            return message;
          }

          const persisted = conversationMessages[index - startIndex];
          return {
            ...message,
            id: resolveHistoryMessageId(persisted, index - startIndex),
            timestamp: resolveHistoryMessageTimestamp(persisted),
            attachments:
              persisted.role === "user"
                ? toRuntimeAttachments(persisted.attachments)
                : message.attachments,
          };
        });
      });
    },
    [getActiveRun, params.activeSessionKey],
  );

  const addUserMessage = useCallback(
    (params: {
      sessionKey?: string;
      prompt: string;
      attachments?: CompleteAttachment[];
    }) => {
      const message: AgentMessage = {
        id: generateId(),
        role: "user",
        parts: params.prompt ? [{ type: "text", text: params.prompt }] : [],
        attachments: params.attachments,
        timestamp: Date.now() / 1000,
        status: "complete",
      };
      setMessages((previous) => [...previous, message]);
    },
    [],
  );

  const sendMessage = useCallback(
    async (requestParams: {
      sessionKey: string;
      prompt: string;
      attachments?: GatewayChatAttachment[];
      recoveryBaseline: ChatMessage[];
      idempotencyKey?: string;
    }) => {
      const runId = requestParams.idempotencyKey?.trim() || crypto.randomUUID();
      const activeRun = startActiveRun({
        origin: "local",
        runId,
        sessionKey: requestParams.sessionKey,
        recoveryBaseline: requestParams.recoveryBaseline,
      });
      let sentToGateway = false;
      let shouldKeepSettlingRun = false;

      try {
        if (params.transport === "http") {
          const abortController = new AbortController();
          activeRun.abortController = abortController;

          await streamAgentChat({
            sessionKey: requestParams.sessionKey,
            prompt: requestParams.prompt,
            idempotencyKey: runId,
            attachments: requestParams.attachments,
            signal: abortController.signal,
            onEvent: (eventName, eventPayload) => {
              if (getActiveRun(activeRun.sessionKey) !== activeRun) {
                return;
              }

              if (eventName === "started") {
                sentToGateway = true;
                const payload = eventPayload as { runId?: unknown };
                if (typeof payload.runId === "string" && payload.runId.trim()) {
                  activeRun.runId = payload.runId.trim();
                  persistActiveRunSnapshot(activeRun);
                }
                return;
              }

              if (eventName === "chat") {
                sentToGateway = true;
                const payload = eventPayload as ChatEventPayload;
                if (activeRun.handoffCompleted) {
                  return;
                }
                if (
                  activeRun.phase === "settling" &&
                  (payload.state === "delta" || payload.state === "final")
                ) {
                  return;
                }
                if (payload.state === "delta" || payload.state === "final") {
                  const nextText = extractTextFromMessage(payload.message);
                  activeRun.assistantText = nextText;
                  setAssistantText(activeRun, nextText);
                  if (payload.state === "final") {
                    markAssistantComplete(activeRun);
                    enterSettlingPhase(activeRun);
                  }
                  return;
                }

                if (payload.state === "error") {
                  if (isRecoverableRequestError(payload.errorMessage)) {
                    activeRun.pendingRecovery = true;
                    setConnectionError(OVERLOAD_RECOVERY_MESSAGE);
                    return;
                  }
                  const errorMessage = getUserFacingRequestError(
                    payload.errorMessage,
                  );
                  markAssistantError(activeRun, errorMessage);
                  setConnectionError(errorMessage);
                }
                return;
              }

              if (eventName === "agent") {
                sentToGateway = true;
                const payload = eventPayload as AgentEventPayload;
                if (payload.stream !== "tool") {
                  return;
                }
                const phase =
                  typeof payload.data?.phase === "string"
                    ? payload.data.phase
                    : "";
                const toolArgs = extractToolArgs(payload.data);
                const toolCallId =
                  typeof payload.data?.toolCallId === "string"
                    ? payload.data.toolCallId
                    : "";
                const toolName =
                  typeof payload.data?.name === "string"
                    ? payload.data.name
                    : "tool";
                if (!toolCallId) {
                  return;
                }
                if (activeRun.hiddenToolCallIds.has(toolCallId)) {
                  return;
                }
                if (phase === "start" && !shouldDisplayToolCall(toolName)) {
                  activeRun.hiddenToolCallIds.add(toolCallId);
                  return;
                }

                if (
                  phase === "start" ||
                  phase === "update" ||
                  phase === "result" ||
                  phase === "error" ||
                  phase === "end"
                ) {
                  const resultText =
                    phase === "error"
                      ? String(payload.data?.error || "Tool failed")
                      : extractToolResultText(payload.data?.result);
                  applyToolEvent({
                    activeRun,
                    phase: phase as ToolEventPhase,
                    toolCallId,
                    toolName,
                    toolArgs,
                    resultText,
                  });
                }
                return;
              }

              if (eventName === "error") {
                const payload = eventPayload as { message?: unknown };
                const errorMessage = getUserFacingRequestError(
                  typeof payload.message === "string"
                    ? payload.message
                    : undefined,
                );
                setConnectionError(errorMessage);
                markAssistantError(activeRun, errorMessage);
              }
            },
          });

          if (getActiveRun(activeRun.sessionKey) !== activeRun) {
            return { assistantText: activeRun.assistantText };
          }
          if (!activeRun.assistantText.trim() && !activeRun.cancelled) {
            await recoverActiveRun(activeRun);
          }
          markAssistantComplete(activeRun);
          enterSettlingPhase(activeRun);
          shouldKeepSettlingRun = true;
          return { assistantText: activeRun.assistantText, sentToGateway };
        }

        const sendResult = await getGatewayClient().sendChat({
          sessionKey: requestParams.sessionKey,
          message: requestParams.prompt,
          idempotencyKey: runId,
          attachments: requestParams.attachments,
        });
        sentToGateway = true;
        if (typeof sendResult?.runId === "string" && sendResult.runId.trim()) {
          activeRun.runId = sendResult.runId.trim();
          persistActiveRunSnapshot(activeRun);
        }

        const waitResult = await getGatewayClient().waitForRun(activeRun.runId);
        if (getActiveRun(activeRun.sessionKey) !== activeRun) {
          return { assistantText: activeRun.assistantText, sentToGateway };
        }

        if (
          waitResult.status === "ok" ||
          waitResult.status === "done" ||
          activeRun.cancelled
        ) {
          if (!activeRun.assistantText.trim()) {
            await recoverActiveRun(activeRun);
          }
          markAssistantComplete(activeRun);
          enterSettlingPhase(activeRun);
          shouldKeepSettlingRun = true;
          return { assistantText: activeRun.assistantText, sentToGateway };
        }

        if (waitResult.status === "timeout") {
          await recoverActiveRun(activeRun);
          markAssistantComplete(activeRun);
          enterSettlingPhase(activeRun);
          shouldKeepSettlingRun = true;
          return { assistantText: activeRun.assistantText, sentToGateway };
        }

        throw new Error(
          typeof waitResult.error === "string"
            ? waitResult.error
            : "OpenClaw agent run failed",
        );
      } catch (error) {
        if (activeRun.cancelled) {
          markAssistantComplete(activeRun);
          return { assistantText: activeRun.assistantText };
        }
        if (error instanceof DOMException && error.name === "AbortError") {
          markAssistantComplete(activeRun);
          return { assistantText: activeRun.assistantText };
        }
        if (isRecoverableRequestError(error)) {
          await recoverActiveRun(activeRun);
          if (activeRun.assistantText.trim()) {
            markAssistantComplete(activeRun);
            enterSettlingPhase(activeRun);
            shouldKeepSettlingRun = true;
            return { assistantText: activeRun.assistantText };
          }
        }
        const message = getUserFacingRequestError(error);
        setConnectionError(message);
        markAssistantError(activeRun, message);
        const nextError: GatewayAwareError =
          error instanceof Error
            ? (error as GatewayAwareError)
            : new Error(message);
        nextError.sentToGateway = sentToGateway;
        throw nextError;
      } finally {
        if (!shouldKeepSettlingRun) {
          clearActiveRun(activeRun);
        }
      }
    },
    [
      applyToolEvent,
      clearActiveRun,
      enterSettlingPhase,
      getActiveRun,
      markAssistantComplete,
      markAssistantError,
      params.transport,
      persistActiveRunSnapshot,
      recoverActiveRun,
      setAssistantText,
      startActiveRun,
    ],
  );

  const cancelStream = useCallback(() => {
    const activeRun = getActiveRun(params.activeSessionKey);
    if (!activeRun) {
      return;
    }
    activeRun.cancelled = true;
    if (params.transport === "http") {
      activeRun.abortController?.abort();
      void abortAgentChat({
        sessionKey: activeRun.sessionKey,
        runId: activeRun.runId,
      }).catch(() => {
        // Best effort: local abort already closed the stream.
      });
    } else {
      void getGatewayClient()
        .abortChat({
          sessionKey: activeRun.sessionKey,
          runId: activeRun.runId,
        })
        .catch(() => {
          // The wait path will recover/finalize if the socket is reconnecting.
        });
    }
    markAssistantComplete(activeRun);
    clearActiveRun(activeRun);
  }, [
    clearActiveRun,
    getActiveRun,
    markAssistantComplete,
    params.activeSessionKey,
    params.transport,
  ]);

  return {
    messages,
    isStreaming: isSessionStreaming(params.activeSessionKey),
    runningSessionKeys,
    isSessionStreaming,
    connectionError,
    clearMessages,
    setMessagesFromHistory,
    appendMessagesFromHistory,
    adoptMessagesFromHistory,
    addUserMessage,
    sendMessage,
    cancelStream,
  };
}
