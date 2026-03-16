"use client";

import { memo } from "react";
import {
  CheckIcon,
  FileTextIcon,
  FolderTreeIcon,
  GlobeIcon,
  LoaderIcon,
  SearchIcon,
  TerminalIcon,
} from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { cn } from "@/lib/utils";

/* ── Tool name → human-readable label & icon ── */

interface ToolMeta {
  label: string;
  runningLabel?: string;
  doneLabel?: string;
  icon: React.ElementType;
}

// Lookup uses lowercase keys so both "Read" and "read" resolve correctly.
const TOOL_MAP: Record<string, ToolMeta> = {
  // Claude Code tools (come as lowercase from OpenClaw)
  read: {
    label: "Document",
    runningLabel: "Reading document",
    doneLabel: "Document read",
    icon: FileTextIcon,
  },
  write: { label: "Create file", icon: FileTextIcon },
  edit: { label: "Edit file", icon: FileTextIcon },
  glob: { label: "Find files", icon: FolderTreeIcon },
  grep: { label: "Search content", icon: SearchIcon },
  bash: {
    label: "Command",
    runningLabel: "Running command",
    doneLabel: "Command finished",
    icon: TerminalIcon,
  },
  exec: {
    label: "Command",
    runningLabel: "Running command",
    doneLabel: "Command finished",
    icon: TerminalIcon,
  },
  exec_command: {
    label: "Command",
    runningLabel: "Running command",
    doneLabel: "Command finished",
    icon: TerminalIcon,
  },
  "functions.exec_command": {
    label: "Command",
    runningLabel: "Running command",
    doneLabel: "Command finished",
    icon: TerminalIcon,
  },
  write_stdin: {
    label: "Command",
    runningLabel: "Command still running",
    doneLabel: "Command completed",
    icon: TerminalIcon,
  },
  "functions.write_stdin": {
    label: "Command",
    runningLabel: "Command still running",
    doneLabel: "Command completed",
    icon: TerminalIcon,
  },
  agent: { label: "Research", icon: SearchIcon },
  todowrite: { label: "Plan work", icon: FileTextIcon },
  webfetch: { label: "Fetch page", icon: GlobeIcon },
  websearch: { label: "Web search", icon: GlobeIcon },
  search_query: {
    label: "Web search",
    runningLabel: "Searching the web",
    doneLabel: "Web search completed",
    icon: GlobeIcon,
  },
  image_query: {
    label: "Image search",
    runningLabel: "Searching images",
    doneLabel: "Image search completed",
    icon: GlobeIcon,
  },
  open: { label: "Open page", icon: GlobeIcon },
  click: { label: "Open link", icon: GlobeIcon },
  find: { label: "Inspect page", icon: SearchIcon },
  list_mcp_resources: { label: "Check source", icon: FolderTreeIcon },
  "functions.list_mcp_resources": { label: "Check source", icon: FolderTreeIcon },
  read_mcp_resource: { label: "Load reference", icon: FileTextIcon },
  "functions.read_mcp_resource": { label: "Load reference", icon: FileTextIcon },
  update_plan: { label: "Structure work", icon: FileTextIcon },
  "functions.update_plan": { label: "Structure work", icon: FileTextIcon },
};

function getArgsRecord(args: unknown): Record<string, unknown> | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }
  return args as Record<string, unknown>;
}

function getCommand(args: unknown): string | null {
  const record = getArgsRecord(args);
  if (!record) {
    return null;
  }

  for (const key of ["cmd", "command"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

function getSharePointUploadDetail(args: unknown): string | null {
  const command = getCommand(args);
  if (!command || !/sharepoint/i.test(command) || !/\bupload\b/i.test(command)) {
    return null;
  }

  const match = command.match(/\bupload\s+["']?([^"'\s]+)/i);
  return match?.[1] ? basename(match[1]) : "Uploading file";
}

function isSharePointUpload(toolName: string, args: unknown): boolean {
  const key = toolName.toLowerCase();
  if (!["bash", "exec", "exec_command", "functions.exec_command"].includes(key)) {
    return false;
  }
  return getSharePointUploadDetail(args) !== null;
}

function getToolMeta(toolName: string, args: unknown): ToolMeta {
  if (isSharePointUpload(toolName, args)) {
    return {
      label: "SharePoint upload",
      runningLabel: "Uploading file to SharePoint",
      doneLabel: "SharePoint upload completed",
      icon: FolderTreeIcon,
    };
  }

  // Normalize to lowercase for lookup (OpenClaw sends lowercase tool names)
  const key = toolName.toLowerCase();
  if (TOOL_MAP[key]) return TOOL_MAP[key];
  // Also try exact match for MCP tools with mixed case
  if (TOOL_MAP[toolName]) return TOOL_MAP[toolName];

  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    const shortName =
      parts.length >= 3 ? parts.slice(2).join("_") : parts[parts.length - 1];
    return { label: shortName.replace(/_/g, " "), icon: FolderTreeIcon };
  }

  return { label: toolName, icon: TerminalIcon };
}

function getDisplayCount(args: unknown): number | null {
  const count = getArgsRecord(args)?.count;
  return typeof count === "number" && Number.isFinite(count) && count > 1
    ? count
    : null;
}

function getToolPath(args: unknown): string | null {
  const record = getArgsRecord(args);
  if (!record) {
    return null;
  }

  for (const key of ["path", "file_path", "filePath", "target_file", "targetFile"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function getToolDetail(toolName: string, args: unknown): string | null {
  const key = toolName.toLowerCase();
  const record = getArgsRecord(args);

  if (isSharePointUpload(toolName, args)) {
    return getSharePointUploadDetail(args);
  }

  if (!record) {
    return null;
  }

  const path = getToolPath(record);
  if (path && key === "read") {
    return basename(path);
  }

  if (
    (key === "search_query" || key === "image_query" || key === "websearch") &&
    typeof record.q === "string" &&
    record.q.trim()
  ) {
    return record.q.trim();
  }

  return null;
}

const ToolFallbackImpl: ToolCallMessagePartComponent = ({
  toolName,
  status,
  args,
}) => {
  const isRunning = status?.type === "running";
  const meta = getToolMeta(toolName, args);
  const Icon = meta.icon;
  const label = isRunning
    ? (meta.runningLabel ?? meta.label)
    : (meta.doneLabel ?? meta.label);
  const detail = getToolDetail(toolName, args);
  const count = getDisplayCount(args);

  return (
    <div
      className={cn(
        "my-2 flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm",
        isRunning
          ? "border-primary/20 bg-primary/5 text-foreground"
          : "border-border/70 bg-muted/35 text-foreground/90",
      )}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full",
          isRunning ? "bg-primary/10 text-primary" : "bg-background text-muted-foreground",
        )}
      >
        <Icon className="size-4" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{label}</span>
          {count ? (
            <span className="rounded-full bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
              {count}x
            </span>
          ) : null}
        </div>
        {detail ? (
          <div className="truncate text-xs text-muted-foreground">{detail}</div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        <span>{isRunning ? "Aktiv" : "Fertig"}</span>
        {isRunning ? (
          <LoaderIcon className="size-3 animate-spin text-primary/70" />
        ) : (
          <CheckIcon className="size-3 text-green-600/80" />
        )}
      </div>
    </div>
  );
};

export const ToolFallback = memo(
  ToolFallbackImpl,
) as unknown as ToolCallMessagePartComponent;

ToolFallback.displayName = "ToolFallback";
