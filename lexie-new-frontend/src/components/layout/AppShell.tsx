import { useEffect, useState } from "react";
import { PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import Sidebar from "./Sidebar";
import type { AvailableAgent, Session } from "@/lib/types";
import type { ViewportKind } from "@/hooks/use-viewport-kind";

interface AppShellProps {
  children: (props: { openSidebar: () => void }) => React.ReactNode;
  viewportKind: ViewportKind;
  sessions: Session[];
  archivedSessions: Session[];
  sessionActivityById?: Record<
    string,
    { running: boolean; sending: boolean; queuedCount: number }
  >;
  currentSessionId: string | null;
  onSelectSession: (id: string | null) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => void | Promise<void>;
  onArchiveSession: (id: string) => void | Promise<void>;
  onUnarchiveSession: (id: string) => void | Promise<void>;
  availableAgents: AvailableAgent[];
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
}

export default function AppShell({
  children,
  viewportKind,
  sessions,
  archivedSessions,
  sessionActivityById,
  currentSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onArchiveSession,
  onUnarchiveSession,
  availableAgents,
  selectedAgentId,
  onSelectAgent,
}: AppShellProps) {
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const [overlaySidebarOpen, setOverlaySidebarOpen] = useState(false);
  const isDesktop = viewportKind === "desktop";
  const isPhone = viewportKind === "phone";
  const sidebarOpen = isDesktop ? desktopSidebarOpen : overlaySidebarOpen;

  useEffect(() => {
    if (isDesktop) {
      setOverlaySidebarOpen(false);
    }
  }, [isDesktop]);

  const openSidebar = () => {
    if (isDesktop) {
      setDesktopSidebarOpen(true);
      return;
    }
    setOverlaySidebarOpen(true);
  };

  const closeSidebar = () => {
    if (isDesktop) {
      setDesktopSidebarOpen(false);
      return;
    }
    setOverlaySidebarOpen(false);
  };

  const sidebar = (
    <Sidebar
      open={sidebarOpen}
      mode={isDesktop ? "desktop" : "overlay"}
      closeOnSelect={isPhone}
      isTouchLayout={!isDesktop}
      onRequestClose={closeSidebar}
      onToggle={() => {
        if (isDesktop) {
          setDesktopSidebarOpen((open) => !open);
          return;
        }
        setOverlaySidebarOpen(false);
      }}
      sessions={sessions}
      archivedSessions={archivedSessions}
      sessionActivityById={sessionActivityById}
      currentSessionId={currentSessionId}
      onSelectSession={onSelectSession}
      onNewSession={onNewSession}
      onDeleteSession={onDeleteSession}
      onArchiveSession={onArchiveSession}
      onUnarchiveSession={onUnarchiveSession}
      availableAgents={availableAgents}
      selectedAgentId={selectedAgentId}
      onSelectAgent={onSelectAgent}
    />
  );

  return (
    <div className="relative flex h-full overflow-hidden bg-background">
      {isDesktop ? (
        sidebar
      ) : (
        <Dialog open={overlaySidebarOpen} onOpenChange={setOverlaySidebarOpen}>
          <DialogContent
            showCloseButton={false}
            className="top-0 left-0 flex h-[100dvh] w-[min(24rem,100vw)] max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-0 border-r border-sidebar-border p-0 shadow-2xl"
          >
            {sidebar}
          </DialogContent>
        </Dialog>
      )}

      <main className="relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden">
        {!sidebarOpen && (
          <Button
            variant="ghost"
            size="icon"
            onClick={openSidebar}
            className="absolute top-4 left-4 z-40 hidden rounded-full border border-border/80 bg-card/95 shadow-sm backdrop-blur-sm lg:flex"
          >
            <PanelLeft size={16} />
          </Button>
        )}

        <div className="flex min-h-0 flex-1 flex-col">{children({ openSidebar })}</div>
      </main>
    </div>
  );
}
