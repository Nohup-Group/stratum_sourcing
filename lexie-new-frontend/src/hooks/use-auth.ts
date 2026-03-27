import { useEffect, useState } from "react";
import { getBrowserClientId } from "@/lib/browser-client";

export interface AuthState {
  isLoading: boolean;
  isAuthenticated: boolean;
  userType: "internal" | "investor" | null;
  investorName: string | null;
}

interface AuthMeResponse {
  type: "internal" | "investor";
  name?: string;
  inviteId?: string;
}

const LEXIE_CLIENT_ID_HEADER = "X-Lexie-Client-Id";

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    isLoading: true,
    isAuthenticated: false,
    userType: null,
    investorName: null,
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
          });
        } else {
          setState({
            isLoading: false,
            isAuthenticated: false,
            userType: null,
            investorName: null,
          });
        }
      } catch {
        if (!cancelled) {
          setState({
            isLoading: false,
            isAuthenticated: false,
            userType: null,
            investorName: null,
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
