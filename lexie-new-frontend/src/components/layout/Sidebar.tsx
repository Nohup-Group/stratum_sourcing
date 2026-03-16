import { useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  PanelLeftClose,
  Plus,
  Trash2,
} from "lucide-react";
import type { Session } from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import ThemeToggle from "./ThemeToggle";

interface SidebarProps {
  open: boolean;
  mode?: "desktop" | "overlay";
  closeOnSelect?: boolean;
  isTouchLayout?: boolean;
  onRequestClose?: () => void;
  onToggle: () => void;
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
}

function SessionRow(props: {
  session: Session;
  active: boolean;
  statusLabel: string | null;
  isTouchLayout: boolean;
  onSelect: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
  onDelete?: () => void;
}) {
  return (
    <button
      onClick={props.onSelect}
      className={cn(
        "group relative flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left transition-all duration-150",
        props.active
          ? "border-primary/25 bg-primary/8 text-foreground shadow-[0_12px_30px_rgba(78,0,255,0.10)]"
          : "border-transparent bg-transparent text-muted-foreground hover:border-border/60 hover:bg-card/70 hover:text-foreground",
      )}
    >
      <div className="relative flex size-9 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <MessageSquare size={16} />
        {props.statusLabel && (
          <span className="absolute -top-1 -right-1 flex size-2.5 rounded-full bg-primary" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-sm font-medium">{props.session.name}</div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>{formatDate(new Date(props.session.updated_at).getTime() / 1000)}</span>
          {props.statusLabel && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">
              {props.statusLabel}
            </span>
          )}
        </div>
      </div>

      <div
        className={cn(
          "flex shrink-0 items-center gap-1 transition-opacity",
          props.isTouchLayout ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        {props.onArchive && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              props.onArchive?.();
            }}
            className="rounded-full p-2 text-muted-foreground hover:bg-primary/10 hover:text-primary"
            aria-label="Archive session"
          >
            <Archive size={14} />
          </button>
        )}

        {props.onUnarchive && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              props.onUnarchive?.();
            }}
            className="rounded-full p-2 text-muted-foreground hover:bg-primary/10 hover:text-primary"
            aria-label="Restore session"
          >
            <ArchiveRestore size={14} />
          </button>
        )}

        {props.onDelete && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              props.onDelete?.();
            }}
            className="rounded-full p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            aria-label="Delete session"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </button>
  );
}

export default function Sidebar({
  open,
  mode = "desktop",
  closeOnSelect = false,
  isTouchLayout = false,
  onRequestClose,
  onToggle,
  sessions,
  archivedSessions,
  sessionActivityById,
  currentSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onArchiveSession,
  onUnarchiveSession,
}: SidebarProps) {
  const [archiveOpen, setArchiveOpen] = useState(false);

  if (!open) {
    return null;
  }

  const closeIfNeeded = () => {
    if (closeOnSelect) {
      onRequestClose?.();
    }
  };

  return (
    <aside
      className={cn(
        "relative z-20 flex h-full flex-col overflow-hidden border-r border-sidebar-border bg-sidebar/92 text-sidebar-foreground backdrop-blur-xl",
        mode === "desktop" ? "w-[316px]" : "w-full min-w-0",
      )}
    >
      <div className="px-5 pb-4 pt-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <img
              src="/logo-lockup-light.png"
              alt="Stratum"
              className="block h-auto w-[13.5rem] max-w-full object-contain object-left dark:hidden"
            />
            <img
              src="/logo-lockup-dark.png"
              alt="Stratum"
              className="hidden h-auto w-[13.5rem] max-w-full object-contain object-left dark:block"
            />
          </div>

          <Button variant="ghost" size="icon-xs" onClick={onToggle} className="rounded-full">
            <PanelLeftClose size={16} />
          </Button>
        </div>

        <Button
          variant="default"
          className="mt-5 h-11 w-full justify-center gap-2 rounded-2xl shadow-[0_12px_30px_rgba(78,0,255,0.18)]"
          onClick={() => {
            onNewSession();
            closeIfNeeded();
          }}
        >
          <Plus size={16} />
          New chat
        </Button>
      </div>

      <Separator />

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 px-3 py-4">
          <section>
            <div className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Active
            </div>
            {sessions.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border/80 bg-card/50 px-4 py-6 text-sm text-muted-foreground">
                Start a new chat to create your first Lexie session.
              </div>
            ) : (
              <div className="space-y-2">
                {sessions.map((session) => {
                  const activity = sessionActivityById?.[session.id];
                  const statusLabel = activity?.running
                    ? "Running"
                    : activity?.sending
                      ? "Syncing"
                      : null;
                  return (
                    <SessionRow
                      key={session.id}
                      session={session}
                      active={currentSessionId === session.id}
                      statusLabel={statusLabel}
                      isTouchLayout={isTouchLayout}
                      onSelect={() => {
                        onSelectSession(session.id);
                        closeIfNeeded();
                      }}
                      onArchive={() => void onArchiveSession(session.id)}
                      onDelete={() => void onDeleteSession(session.id)}
                    />
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <button
              type="button"
              onClick={() => setArchiveOpen((openValue) => !openValue)}
              className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-foreground"
            >
              {archiveOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              Archived
            </button>

            {archiveOpen && (
              <div className="mt-2 space-y-2">
                {archivedSessions.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-border/70 bg-card/40 px-4 py-4 text-sm text-muted-foreground">
                    Archived chats will appear here.
                  </div>
                ) : (
                  archivedSessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      active={false}
                      statusLabel={null}
                      isTouchLayout={isTouchLayout}
                      onSelect={() => {
                        void Promise.resolve(onUnarchiveSession(session.id)).then(() => {
                          onSelectSession(session.id);
                        });
                        closeIfNeeded();
                      }}
                      onUnarchive={() => void onUnarchiveSession(session.id)}
                      onDelete={() => void onDeleteSession(session.id)}
                    />
                  ))
                )}
              </div>
            )}
          </section>
        </div>
      </ScrollArea>

      <div className="border-t border-sidebar-border p-3">
        <ThemeToggle />
      </div>
    </aside>
  );
}
