import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi, describe, expect, it } from "vitest";
import App from "./App";

vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/hooks/use-agent-runtime", () => ({
  useAgentRuntime: () => ({
    runtime: {} as object,
    sessions: [],
    archivedSessions: [],
    sessionActivityById: {},
    currentSession: null,
    currentSessionId: null,
    createSession: vi.fn(),
    deleteSession: vi.fn(),
    selectSession: vi.fn(),
    archiveSession: vi.fn(),
    unarchiveSession: vi.fn(),
    connectionError: null,
    chatCapabilities: {
      gatewayReady: true,
      gatewayReason: null,
      chatModelId: null,
      sandbox: { enabled: true, type: "remote" },
      webSearch: { available: true, provider: "perplexity", reason: null },
      pricing: { configured: false, model: null },
    },
    webSearchEnabled: false,
    webSearchLoading: false,
    setWebSearchEnabled: vi.fn(),
    sessionSettingsAvailable: false,
    verboseLevel: "on",
    queueMode: "collect",
    sessionSettingsLoading: false,
    setVerboseLevel: vi.fn(),
    setQueueMode: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-viewport-kind", () => ({
  useViewportKind: () => "desktop",
}));

vi.mock("@/components/chat/ChatArea", () => ({
  default: () => <div>Chat area</div>,
}));

describe("App", () => {
  it("renders the Stratum shell without project selection controls", () => {
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );

    expect(screen.getByText(/Start a new chat to create your first Lexie session/i)).toBeTruthy();
    expect(screen.getByText(/Lexie for Stratum sourcing workflows/i)).toBeTruthy();
    expect(screen.queryByText(/Project/i)).toBeNull();
  });
});
