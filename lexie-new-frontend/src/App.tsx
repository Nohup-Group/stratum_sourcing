import { AssistantRuntimeProvider } from "@assistant-ui/react";
import ChatArea from "@/components/chat/ChatArea";
import AppShell from "@/components/layout/AppShell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAgentRuntime } from "@/hooks/use-agent-runtime";
import { useViewportKind } from "@/hooks/use-viewport-kind";

export default function App() {
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
    webSearchEnabled,
    webSearchLoading,
    setWebSearchEnabled,
    sessionSettingsAvailable,
    verboseLevel,
    queueMode,
    sessionSettingsLoading,
    setVerboseLevel,
    setQueueMode,
  } = useAgentRuntime();
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
            selectSession(null);
            void createSession();
          }}
          onDeleteSession={deleteSession}
          onArchiveSession={archiveSession}
          onUnarchiveSession={unarchiveSession}
        >
          {({ openSidebar }) => (
            <ChatArea
              viewportKind={viewportKind}
              hasSession={Boolean(currentSession)}
              connectionError={connectionError}
              currentSession={currentSession}
              onOpenSidebar={openSidebar}
              chatCapabilities={chatCapabilities}
              webSearchEnabled={webSearchEnabled}
              webSearchLoading={webSearchLoading}
              onWebSearchToggle={setWebSearchEnabled}
              sessionSettingsAvailable={sessionSettingsAvailable}
              verboseLevel={verboseLevel}
              queueMode={queueMode}
              sessionSettingsLoading={sessionSettingsLoading}
              onVerboseLevelChange={setVerboseLevel}
              onQueueModeChange={setQueueMode}
            />
          )}
        </AppShell>
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}
