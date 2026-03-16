import { Menu, Sparkles } from "lucide-react";
import { Thread } from "@/components/assistant-ui/thread";
import { Button } from "@/components/ui/button";
import type { OpenClawChatCapabilities, Session } from "@/lib/types";
import type { ViewportKind } from "@/hooks/use-viewport-kind";
import WelcomeContent from "./WelcomeContent";

interface ChatAreaProps {
  viewportKind: ViewportKind;
  hasSession: boolean;
  connectionError?: string | null;
  chatCapabilities?: OpenClawChatCapabilities | null;
  currentSession?: Session | null;
  onOpenSidebar: () => void;
}

export default function ChatArea({
  viewportKind,
  hasSession,
  connectionError,
  chatCapabilities,
  currentSession,
  onOpenSidebar,
}: ChatAreaProps) {
  const subtitle = currentSession
    ? null
    : "Start a new chat or type to open one automatically";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(78,0,255,0.14),transparent_38%),radial-gradient(circle_at_bottom_right,rgba(78,0,255,0.08),transparent_28%)]" />

      <header className="relative z-10 border-b border-border/70 bg-background/85 px-4 py-3 backdrop-blur-xl sm:px-6">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onOpenSidebar}
            className="shrink-0 rounded-full lg:hidden"
          >
            <Menu className="size-4" />
            <span className="sr-only">Open navigation</span>
          </Button>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <div className="truncate text-sm font-semibold text-foreground sm:text-base">
                {currentSession?.name ?? "Stratum Lexie"}
              </div>
              {chatCapabilities?.gatewayReady && (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">
                  <Sparkles className="size-3" />
                  Ready
                </span>
              )}
            </div>
            {subtitle ? (
              <div className="truncate text-[11px] text-muted-foreground sm:text-xs">
                {subtitle}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {connectionError && (
        <div className="relative z-10 px-4 pt-3 sm:px-6">
          <div className="rounded-2xl border border-primary/20 bg-primary/8 px-4 py-3 text-sm text-foreground">
            {connectionError}
          </div>
        </div>
      )}

      <div className="relative z-10 min-h-0 flex-1 overflow-hidden">
        <Thread
          viewportKind={viewportKind}
          welcomeContent={<WelcomeContent />}
        />
      </div>
    </div>
  );
}
