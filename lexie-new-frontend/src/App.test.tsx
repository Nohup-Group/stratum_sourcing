import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi, describe, expect, it, beforeEach } from "vitest";
import App from "./App";

const useAuthMock = vi.fn();

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

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock("@/hooks/use-viewport-kind", () => ({
  useViewportKind: () => "desktop",
}));

vi.mock("@/components/chat/ChatArea", () => ({
  default: () => <div>Chat area</div>,
}));

describe("App", () => {
  beforeEach(() => {
    useAuthMock.mockReset();
  });

  it("shows a loading spinner while auth state is resolving", () => {
    useAuthMock.mockReturnValue({
      isLoading: true,
      isAuthenticated: false,
      userType: null,
      investorName: null,
    });

    const queryClient = new QueryClient();

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );

    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });

  it("renders the invite gate for unauthenticated users", () => {
    useAuthMock.mockReturnValue({
      isLoading: false,
      isAuthenticated: false,
      userType: null,
      investorName: null,
    });

    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );

    expect(screen.getByText(/Welcome to Lexie/i)).toBeTruthy();
  });

  it("renders the authenticated shell once auth succeeds", () => {
    useAuthMock.mockReturnValue({
      isLoading: false,
      isAuthenticated: true,
      userType: "internal",
      investorName: null,
    });

    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Chat area")).toBeTruthy();
  });
});
