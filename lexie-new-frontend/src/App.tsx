import { AssistantRuntimeProvider } from "@assistant-ui/react";
import ChatArea from "@/components/chat/ChatArea";
import InviteGate from "@/components/auth/InviteGate";
import AppShell from "@/components/layout/AppShell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAgentRuntime } from "@/hooks/use-agent-runtime";
import { useAuth } from "@/hooks/use-auth";
import { useViewportKind } from "@/hooks/use-viewport-kind";
import type { AvailableAgent } from "@/lib/types";

function AuthenticatedApp(props: {
  userType: "internal" | "investor";
  availableAgents: AvailableAgent[];
  defaultAgentId: string | null;
}) {
  const {
    runtime,
    sessions,
    archivedSessions,
    sessionActivityById,
    currentSession,
    currentSessionId,
    createSession,
    deleteSession,
    selectSession,
    archiveSession,
    unarchiveSession,
    connectionError,
    chatCapabilities,
    availableAgents,
    selectedAgentId,
    selectAgent,
  } = useAgentRuntime({
    userType: props.userType,
    availableAgents: props.availableAgents,
    defaultAgentId: props.defaultAgentId,
  });
  const viewportKind = useViewportKind();

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        <AppShell
          viewportKind={viewportKind}
          sessions={sessions}
          archivedSessions={archivedSessions}
          sessionActivityById={sessionActivityById}
          currentSessionId={currentSessionId}
          onSelectSession={selectSession}
          onNewSession={() => {
            void createSession();
          }}
          onDeleteSession={deleteSession}
          onArchiveSession={archiveSession}
          onUnarchiveSession={unarchiveSession}
          availableAgents={availableAgents}
          selectedAgentId={selectedAgentId}
          onSelectAgent={selectAgent}
        >
          {({ openSidebar }) => (
            <ChatArea
              viewportKind={viewportKind}
              hasSession={Boolean(currentSession)}
              connectionError={connectionError}
              currentSession={currentSession}
              onOpenSidebar={openSidebar}
              chatCapabilities={chatCapabilities}
            />
          )}
        </AppShell>
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

export default function App() {
  const {
    isLoading,
    isAuthenticated,
    userType,
    availableAgents,
    defaultAgentId,
  } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <InviteGate />;
  }

  return (
    <AuthenticatedApp
      userType={userType ?? "internal"}
      availableAgents={availableAgents}
      defaultAgentId={defaultAgentId}
    />
  );
}
