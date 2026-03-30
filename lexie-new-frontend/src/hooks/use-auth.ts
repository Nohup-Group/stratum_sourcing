import { useEffect, useState } from "react";
import { getBrowserClientId } from "@/lib/browser-client";
import type { AvailableAgent } from "@/lib/types";

export interface AuthState {
  isLoading: boolean;
  isAuthenticated: boolean;
  userType: "internal" | "investor" | null;
  investorName: string | null;
  email: string | null;
  availableAgents: AvailableAgent[];
  defaultAgentId: string | null;
}

interface AuthMeResponse {
  type: "internal" | "investor";
  name?: string;
  email?: string;
  inviteId?: string;
  availableAgents?: AvailableAgent[];
  defaultAgentId?: string;
}

const LEXIE_CLIENT_ID_HEADER = "X-Lexie-Client-Id";

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    isLoading: true,
    isAuthenticated: false,
    userType: null,
    investorName: null,
    email: null,
    availableAgents: [],
    defaultAgentId: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const response = await fetch("/api/auth/me", {
          headers: { [LEXIE_CLIENT_ID_HEADER]: getBrowserClientId() },
        });

        if (cancelled) return;

        if (response.ok) {
          const data = (await response.json()) as AuthMeResponse;
          setState({
            isLoading: false,
            isAuthenticated: true,
            userType: data.type,
            investorName: data.name ?? null,
            email: data.email ?? null,
            availableAgents: data.availableAgents ?? [],
            defaultAgentId: data.defaultAgentId ?? data.availableAgents?.[0]?.id ?? null,
          });
        } else {
          setState({
            isLoading: false,
            isAuthenticated: false,
            userType: null,
            investorName: null,
            email: null,
            availableAgents: [],
            defaultAgentId: null,
          });
        }
      } catch {
        if (!cancelled) {
          setState({
            isLoading: false,
            isAuthenticated: false,
            userType: null,
            investorName: null,
            email: null,
            availableAgents: [],
            defaultAgentId: null,
          });
        }
      }
    }

    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
