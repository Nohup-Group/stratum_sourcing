import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createSession as apiCreateSession,
  deleteSession as apiDeleteSession,
  listSessions,
  updateSession as apiUpdateSession,
} from "@/lib/api";
import type { Session, SessionStatus } from "@/lib/types";

const CURRENT_SESSION_STORAGE_KEY = "stratum-lexie-current-session-id";

function loadStoredSessionId(): string | null {
  try {
    return window.localStorage.getItem(CURRENT_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveStoredSessionId(sessionId: string | null): void {
  try {
    if (!sessionId) {
      window.localStorage.removeItem(CURRENT_SESSION_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, sessionId);
  } catch {
    // Ignore storage failures.
  }
}

export function useSessions() {
  const queryClient = useQueryClient();
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : loadStoredSessionId(),
  );

  const sessionsQuery = useQuery({
    queryKey: ["sessions", "ACTIVE"],
    queryFn: () => listSessions("active"),
    staleTime: 10_000,
  });

  const archivedSessionsQuery = useQuery({
    queryKey: ["sessions", "ARCHIVED"],
    queryFn: () => listSessions("archived"),
    staleTime: 10_000,
  });

  const sessions = sessionsQuery.data ?? [];
  const archivedSessions = archivedSessionsQuery.data ?? [];
  const currentSession = sessions.find((session) => session.id === currentSessionId) ?? null;

  useEffect(() => {
    saveStoredSessionId(currentSessionId);
  }, [currentSessionId]);

  useEffect(() => {
    if (currentSessionId && sessions.some((session) => session.id === currentSessionId)) {
      return;
    }

    const nextSessionId = sessions[0]?.id ?? null;
    if (nextSessionId !== currentSessionId) {
      setCurrentSessionId(nextSessionId);
    }
  }, [currentSessionId, sessions]);

  const refreshSessions = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["sessions", "ACTIVE"] }),
      queryClient.invalidateQueries({ queryKey: ["sessions", "ARCHIVED"] }),
    ]);
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: (name: string) => apiCreateSession(name),
    onSuccess: async (created) => {
      setCurrentSessionId(created.id);
      await refreshSessions();
    },
  });

  const updateMutation = useMutation({
    mutationFn: (params: {
      sessionId: string;
      data: { name?: string; status?: SessionStatus };
    }) => apiUpdateSession(params.sessionId, params.data),
    onSuccess: async (_updated, params) => {
      if (params.data.status === "ARCHIVED" && currentSessionId === params.sessionId) {
        setCurrentSessionId(null);
      }
      await refreshSessions();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (sessionId: string) => apiDeleteSession(sessionId),
    onSuccess: async (_result, sessionId) => {
      if (currentSessionId === sessionId) {
        setCurrentSessionId(null);
      }
      await refreshSessions();
    },
  });

  const createSession = useCallback(
    async (name = "New chat"): Promise<Session> => await createMutation.mutateAsync(name),
    [createMutation],
  );

  const renameSession = useCallback(
    async (sessionId: string, name: string): Promise<Session> =>
      await updateMutation.mutateAsync({ sessionId, data: { name } }),
    [updateMutation],
  );

  const archiveSession = useCallback(
    async (sessionId: string): Promise<Session> =>
      await updateMutation.mutateAsync({ sessionId, data: { status: "ARCHIVED" } }),
    [updateMutation],
  );

  const unarchiveSession = useCallback(
    async (sessionId: string): Promise<Session> =>
      await updateMutation.mutateAsync({ sessionId, data: { status: "ACTIVE" } }),
    [updateMutation],
  );

  const deleteSession = useCallback(
    async (sessionId: string): Promise<void> => {
      await deleteMutation.mutateAsync(sessionId);
    },
    [deleteMutation],
  );

  const selectSession = useCallback((sessionId: string | null) => {
    setCurrentSessionId(sessionId);
  }, []);

  return {
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
    sessionsQuery,
    archivedSessionsQuery,
  };
}
