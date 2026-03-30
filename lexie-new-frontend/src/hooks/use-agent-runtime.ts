import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  type AppendMessage,
  type CompleteAttachment,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import {
  fetchOpenClawChatCapabilities,
  touchSession,
  updateSession,
} from "@/lib/api";
import { normalizeGatewayConversation } from "@/lib/gateway-history";
import { getGatewayClient } from "@/lib/openclaw-gateway";
import { generateId } from "@/lib/utils";
import { useMessages } from "./use-messages";
import { useSessions } from "./use-sessions";
import type {
  AgentMessage,
  AvailableAgent,
  ChatMessage,
  GatewayChatAttachment,
  MessageAttachmentMeta,
  OpenClawQueueMode,
  OpenClawVerboseLevel,
} from "@/lib/types";

type ContentPart = NonNullable<Exclude<ThreadMessageLike["content"], string>>[number];

const DEFAULT_SESSION_NAME = "New chat";

function convertMessage(message: AgentMessage): ThreadMessageLike {
  const parts: ContentPart[] = [];

  for (const part of message.parts) {
    if (part.type === "text") {
      parts.push({ type: "text" as const, text: part.text });
      continue;
    }

    const toolCall = part.toolCall;
    parts.push({
      type: "tool-call" as const,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: { ...toolCall.args, count: toolCall.count } as Record<string, unknown>,
      result: toolCall.result,
    });
  }

  let status: ThreadMessageLike["status"];
  if (message.role === "assistant") {
    if (message.status === "streaming") {
      status = { type: "running" };
    } else if (message.status === "error") {
      status = { type: "incomplete", reason: "error" };
    } else {
      status = { type: "complete", reason: "stop" };
    }
  }

  return {
    role: message.role,
    content: parts,
    attachments: message.role === "user" ? message.attachments : undefined,
    id: message.id,
    createdAt: new Date(message.timestamp * 1000),
    status,
  };
}

function readFileAs(file: File, mode: "dataURL" | "arrayBuffer"): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string | ArrayBuffer);
    reader.onerror = (error) => reject(error);
    if (mode === "dataURL") {
      reader.readAsDataURL(file);
    } else {
      reader.readAsArrayBuffer(file);
    }
  });
}

function arrayBufferToBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function truncateSessionName(value: string): string {
  return value.length > 48 ? `${value.slice(0, 48)}...` : value;
}

function buildSessionNameFromValues(
  text: string,
  firstAttachmentName?: string | null,
): string {
  if (text.trim()) {
    return truncateSessionName(text.trim());
  }
  if (firstAttachmentName?.trim()) {
    return truncateSessionName(firstAttachmentName.trim());
  }
  return DEFAULT_SESSION_NAME;
}

function buildSessionName(
  text: string,
  attachments: CompleteAttachment[] | undefined,
): string {
  return buildSessionNameFromValues(text, attachments?.[0]?.name);
}

function toPersistedAttachmentMeta(
  attachments: CompleteAttachment[] | undefined,
): MessageAttachmentMeta[] | undefined {
  if (!attachments?.length) {
    return undefined;
  }

  return attachments.map((attachment) => ({
    id: attachment.id,
    type: attachment.type,
    name: attachment.name,
    content_type: attachment.contentType,
    size_bytes: attachment.file?.size ?? null,
  }));
}

async function buildGatewayAttachments(
  attachments: CompleteAttachment[] | undefined,
): Promise<GatewayChatAttachment[] | undefined> {
  if (!attachments?.length) {
    return undefined;
  }

  return await Promise.all(
    attachments.map(async (attachment) => {
      if (attachment.file) {
        const buffer = await readFileAs(attachment.file, "arrayBuffer");
        return {
          type: attachment.type,
          mimeType: attachment.contentType,
          fileName: attachment.name,
          content: arrayBufferToBase64(buffer as ArrayBuffer),
        };
      }

      const imagePart = attachment.content.find(
        (part): part is Extract<(typeof attachment.content)[number], { type: "image" }> =>
          part.type === "image",
      );
      if (imagePart?.image.startsWith("data:")) {
        const [, base64 = ""] = imagePart.image.split(",", 2);
        return {
          type: attachment.type,
          mimeType: attachment.contentType,
          fileName: attachment.name,
          content: base64,
        };
      }

      return {
        type: attachment.type,
        mimeType: attachment.contentType,
        fileName: attachment.name,
      };
    }),
  );
}

function getMessageText(message: AppendMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function getGatewayStatusMessage(params: {
  isLoading: boolean;
  gatewayReady?: boolean;
  gatewayReason?: string | null;
  error?: Error | null;
}): string | null {
  if (params.error) {
    return params.error.message;
  }
  if (params.isLoading) {
    return null;
  }
  if (params.gatewayReady) {
    return null;
  }
  if (params.gatewayReason === "gateway_starting") {
    return "Lexie is still starting. Retry in a few seconds.";
  }
  return "The gateway is currently unavailable.";
}

export function useAgentRuntime(params?: {
  availableAgents?: AvailableAgent[];
  defaultAgentId?: string | null;
  userType?: "internal" | "investor" | null;
}) {
  const {
    sessions,
    archivedSessions,
    currentSession,
    currentSessionId,
    selectSession,
    createSession,
    renameSession,
    archiveSession,
    unarchiveSession,
    deleteSession,
    refreshSessions,
  } = useSessions();
  const availableAgents = params?.availableAgents ?? [];
  const [selectedAgentId, setSelectedAgentId] = useState<string>(
    params?.defaultAgentId ?? availableAgents[0]?.id ?? "main",
  );
  const renameRequestedRef = useRef<Map<string, string>>(new Map());
  const [pendingSessionIds, setPendingSessionIds] = useState<string[]>([]);
  const [webSearchEnabledBySession, setWebSearchEnabledBySession] = useState<Record<string, boolean>>({});
  const [sessionWebSearchUpdating, setSessionWebSearchUpdating] = useState<Record<string, boolean>>({});
  const [verboseLevelBySession, setVerboseLevelBySession] = useState<Record<string, OpenClawVerboseLevel>>({});
  const [queueModeBySession, setQueueModeBySession] = useState<Record<string, OpenClawQueueMode>>({});
  const [sessionSettingsUpdating, setSessionSettingsUpdating] = useState<Record<string, boolean>>({});

  const chatCapabilitiesQuery = useQuery({
    queryKey: ["openclaw-chat-capabilities"],
    queryFn: fetchOpenClawChatCapabilities,
    staleTime: 5_000,
    refetchInterval: (query) => (query.state.data?.gatewayReady ? 30_000 : 5_000),
  });

  const gatewayEnabled = chatCapabilitiesQuery.data?.gatewayReady === true;
  const historyQuery = useQuery({
    queryKey: ["session-history", currentSession?.id, currentSession?.gateway_session_key],
    queryFn: async () =>
      await getGatewayClient().getChatHistory(currentSession!.gateway_session_key),
    enabled: Boolean(currentSession?.gateway_session_key && gatewayEnabled),
    staleTime: 2_000,
  });

  const historyMessages = useMemo<ChatMessage[]>(
    () => normalizeGatewayConversation(historyQuery.data?.messages ?? []),
    [historyQuery.data],
  );

  useEffect(() => {
    if (currentSession?.agent_id) {
      setSelectedAgentId(currentSession.agent_id);
      return;
    }

    const fallbackAgentId = params?.defaultAgentId ?? availableAgents[0]?.id ?? "main";
    if (!availableAgents.some((agent) => agent.id === selectedAgentId)) {
      setSelectedAgentId(fallbackAgentId);
    }
  }, [availableAgents, currentSession?.agent_id, params?.defaultAgentId, selectedAgentId]);

  const {
    messages,
    isStreaming,
    isSessionStreaming,
    connectionError: runtimeConnectionError,
    clearMessages,
    setMessagesFromHistory,
    addUserMessage,
    sendMessage,
    cancelStream,
  } = useMessages({
    gatewayEnabled,
    transport: "gateway",
    activeSessionKey: currentSession?.gateway_session_key ?? null,
    activeSessionHistory: historyMessages,
    activeSessionHistoryLoaded: !currentSession || historyQuery.isSuccess,
    activeSessionMessageCount: historyMessages.length,
    requestAuthoritativeSessionRefresh: async (sessionKey) => {
      if (sessionKey !== currentSession?.gateway_session_key) {
        return null;
      }
      const refreshed = await historyQuery.refetch();
      return refreshed.data ?? null;
    },
  });

  useEffect(() => {
    if (!currentSession) {
      clearMessages();
      return;
    }

    const isBusy =
      pendingSessionIds.includes(currentSession.id) ||
      isSessionStreaming(currentSession.gateway_session_key);
    if (!isBusy && historyQuery.isSuccess) {
      setMessagesFromHistory(historyMessages);
    }
  }, [
    clearMessages,
    currentSession,
    historyMessages,
    historyQuery.isSuccess,
    isSessionStreaming,
    pendingSessionIds,
    setMessagesFromHistory,
  ]);

  useEffect(() => {
    if (!currentSessionId) {
      return;
    }

    setWebSearchEnabledBySession((current) => ({
      ...current,
      [currentSessionId]: historyQuery.data?.webSearchEnabled === true,
    }));
    setVerboseLevelBySession((current) => ({
      ...current,
      [currentSessionId]: historyQuery.data?.verboseLevel ?? current[currentSessionId] ?? "on",
    }));
    setQueueModeBySession((current) => ({
      ...current,
      [currentSessionId]: historyQuery.data?.queueMode ?? current[currentSessionId] ?? "collect",
    }));
  }, [currentSessionId, historyQuery.data]);

  useEffect(() => {
    if (!currentSession || currentSession.name !== DEFAULT_SESSION_NAME) {
      return;
    }

    const firstUserMessage = historyMessages.find(
      (message) => message.role === "user" && message.content.trim().length > 0,
    );
    if (!firstUserMessage) {
      return;
    }

    const nextName = buildSessionNameFromValues(firstUserMessage.content);
    if (nextName === DEFAULT_SESSION_NAME) {
      return;
    }
    if (renameRequestedRef.current.get(currentSession.id) === nextName) {
      return;
    }

    renameRequestedRef.current.set(currentSession.id, nextName);
    void renameSession(currentSession.id, nextName)
      .then(() => {
        renameRequestedRef.current.delete(currentSession.id);
      })
      .catch(() => {
        renameRequestedRef.current.delete(currentSession.id);
      });
  }, [currentSession, historyMessages, renameSession]);

  const setSessionPending = useCallback((sessionId: string, pending: boolean) => {
    setPendingSessionIds((current) => {
      if (pending) {
        return current.includes(sessionId) ? current : [...current, sessionId];
      }
      return current.filter((entry) => entry !== sessionId);
    });
  }, []);

  const refreshCurrentHistory = useCallback(async () => {
    if (!currentSession) {
      return;
    }
    await historyQuery.refetch();
  }, [currentSession, historyQuery]);

  const handleNew = useCallback(
    async (message: AppendMessage) => {
      const text = getMessageText(message);
      const attachments = (message.attachments ?? []) as CompleteAttachment[];
      if (!text.trim() && attachments.length === 0) {
        return;
      }
      if (!gatewayEnabled) {
        return;
      }

      let session = currentSession;
      if (!session) {
        session = await createSession(
          buildSessionName(text, attachments),
          params?.userType === "investor" ? "investor" : selectedAgentId,
        );
      }

      addUserMessage({
        sessionKey: session.gateway_session_key,
        prompt: text,
        attachments,
      });

      setSessionPending(session.id, true);
      const gatewayAttachments = await buildGatewayAttachments(attachments);
      const baseHistory =
        currentSession?.id === session.id
          ? historyMessages
          : [];

      void touchSession(session.id)
        .then(() => refreshSessions())
        .catch(() => {
          // Ordering updates are best effort only.
        });

      try {
        const result = await sendMessage({
          sessionKey: session.gateway_session_key,
          prompt: text,
          attachments: gatewayAttachments,
          recoveryBaseline: [
            ...baseHistory,
            {
              role: "user",
              content: text,
              attachments: toPersistedAttachmentMeta(attachments),
            },
          ],
        });

        await Promise.allSettled([
          touchSession(session.id),
          refreshSessions(),
          currentSession?.id === session.id ? refreshCurrentHistory() : Promise.resolve(),
        ]);

        if (session.name === DEFAULT_SESSION_NAME) {
          const nextName = buildSessionName(text, attachments);
          if (nextName !== DEFAULT_SESSION_NAME) {
            void updateSession(session.id, { name: nextName }).then(() => refreshSessions());
          }
        }

        return result;
      } catch (error) {
        const sentToGateway =
          error instanceof Error &&
          "sentToGateway" in error &&
          error.sentToGateway === true;
        if (sentToGateway) {
          await Promise.allSettled([
            touchSession(session.id),
            refreshSessions(),
            currentSession?.id === session.id ? refreshCurrentHistory() : Promise.resolve(),
          ]);
        }
      } finally {
        setSessionPending(session.id, false);
      }
    },
    [
      addUserMessage,
      createSession,
      currentSession,
      gatewayEnabled,
      historyMessages,
      params?.userType,
      refreshCurrentHistory,
      refreshSessions,
      selectedAgentId,
      sendMessage,
      setSessionPending,
    ],
  );

  const handleSelectAgent = useCallback(
    (agentId: string) => {
      setSelectedAgentId(agentId);
      if (currentSession?.agent_id && currentSession.agent_id !== agentId) {
        selectSession(null);
      }
    },
    [currentSession?.agent_id, selectSession],
  );

  const createBlankSession = useCallback(async () => {
    await createSession(
      DEFAULT_SESSION_NAME,
      params?.userType === "investor" ? "investor" : selectedAgentId,
    );
  }, [createSession, params?.userType, selectedAgentId]);

  const handleCancel = useCallback(() => {
    cancelStream();
  }, [cancelStream]);

  const setWebSearchEnabled = useCallback(
    async (enabled: boolean) => {
      if (!currentSession?.gateway_session_key || !gatewayEnabled) {
        return;
      }

      setWebSearchEnabledBySession((current) => ({
        ...current,
        [currentSession.id]: enabled,
      }));
      setSessionWebSearchUpdating((current) => ({
        ...current,
        [currentSession.id]: true,
      }));

      try {
        await getGatewayClient().patchChatPreferences({
          sessionKey: currentSession.gateway_session_key,
          webSearchEnabled: enabled,
        });
      } finally {
        setSessionWebSearchUpdating((current) => ({
          ...current,
          [currentSession.id]: false,
        }));
      }
    },
    [currentSession, gatewayEnabled],
  );

  const setVerboseLevel = useCallback(
    async (value: OpenClawVerboseLevel) => {
      if (!currentSession?.gateway_session_key || !gatewayEnabled) {
        return;
      }

      setVerboseLevelBySession((current) => ({
        ...current,
        [currentSession.id]: value,
      }));
      setSessionSettingsUpdating((current) => ({
        ...current,
        [currentSession.id]: true,
      }));

      try {
        await getGatewayClient().patchSessionSettings({
          sessionKey: currentSession.gateway_session_key,
          verboseLevel: value,
        });
      } finally {
        setSessionSettingsUpdating((current) => ({
          ...current,
          [currentSession.id]: false,
        }));
      }
    },
    [currentSession, gatewayEnabled],
  );

  const setQueueMode = useCallback(
    async (value: OpenClawQueueMode) => {
      if (!currentSession?.gateway_session_key || !gatewayEnabled) {
        return;
      }

      setQueueModeBySession((current) => ({
        ...current,
        [currentSession.id]: value,
      }));
      setSessionSettingsUpdating((current) => ({
        ...current,
        [currentSession.id]: true,
      }));

      try {
        await getGatewayClient().patchSessionSettings({
          sessionKey: currentSession.gateway_session_key,
          queueMode: value,
        });
      } finally {
        setSessionSettingsUpdating((current) => ({
          ...current,
          [currentSession.id]: false,
        }));
      }
    },
    [currentSession, gatewayEnabled],
  );

  const sessionActivityById = useMemo(
    () =>
      Object.fromEntries(
        sessions.map((session) => [
          session.id,
          {
            running: isSessionStreaming(session.gateway_session_key),
            sending: pendingSessionIds.includes(session.id),
            queuedCount: 0,
          },
        ]),
      ),
    [isSessionStreaming, pendingSessionIds, sessions],
  );

  const capabilityError =
    chatCapabilitiesQuery.error instanceof Error ? chatCapabilitiesQuery.error : null;
  const historyError = historyQuery.error instanceof Error ? historyQuery.error : null;
  const connectionError =
    getGatewayStatusMessage({
      isLoading: chatCapabilitiesQuery.isLoading,
      gatewayReady: chatCapabilitiesQuery.data?.gatewayReady,
      gatewayReason: chatCapabilitiesQuery.data?.gatewayReason,
      error: capabilityError,
    }) ??
    historyError?.message ??
    runtimeConnectionError;

  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: isStreaming,
    convertMessage,
    onNew: handleNew,
    onCancel: handleCancel,
    adapters: {
      attachments: {
        accept: "*",
        async add(state: { file: File }) {
          const isImage = state.file.type.startsWith("image/");
          return {
            id: crypto.randomUUID(),
            type: (isImage ? "image" : "document") as "image" | "document",
            name: state.file.name,
            contentType: state.file.type,
            file: state.file,
            status: {
              type: "requires-action" as const,
              reason: "composer-send" as const,
            },
          };
        },
        async send(attachment: {
          id: string;
          type: string;
          name: string;
          contentType: string;
          file: File;
          [key: string]: unknown;
        }) {
          const isImage = attachment.contentType.startsWith("image/");

          if (isImage) {
            const dataUrl = (await readFileAs(attachment.file, "dataURL")) as string;
            return {
              id: attachment.id,
              type: "image" as const,
              name: attachment.name,
              contentType: attachment.contentType,
              file: attachment.file,
              status: { type: "complete" as const },
              content: [{ type: "image" as const, image: dataUrl }],
            };
          }

          return {
            id: attachment.id,
            type: "document" as const,
            name: attachment.name,
            contentType: attachment.contentType,
            file: attachment.file,
            status: { type: "complete" as const },
            content: [],
          };
        },
        async remove() {
          // noop
        },
      },
    },
  });

  return {
    runtime,
    sessions,
    archivedSessions,
    sessionActivityById,
    currentSession,
    currentSessionId,
    createSession: createBlankSession,
    deleteSession,
    selectSession,
    archiveSession,
    unarchiveSession,
    availableAgents,
    selectedAgentId,
    selectAgent: handleSelectAgent,
    connectionError,
    chatCapabilities: chatCapabilitiesQuery.data ?? null,
    webSearchEnabled: currentSessionId ? (webSearchEnabledBySession[currentSessionId] ?? false) : false,
    webSearchLoading:
      currentSessionId ? Boolean(sessionWebSearchUpdating[currentSessionId]) || historyQuery.isLoading : false,
    setWebSearchEnabled,
    sessionSettingsAvailable: gatewayEnabled && Boolean(currentSession?.gateway_session_key),
    verboseLevel: currentSessionId ? (verboseLevelBySession[currentSessionId] ?? "on") : "on",
    queueMode: currentSessionId ? (queueModeBySession[currentSessionId] ?? "collect") : "collect",
    sessionSettingsLoading:
      currentSessionId ? Boolean(sessionSettingsUpdating[currentSessionId]) || historyQuery.isLoading : false,
    setVerboseLevel,
    setQueueMode,
  };
}
