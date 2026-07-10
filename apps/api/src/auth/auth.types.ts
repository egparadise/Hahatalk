import type { AuthSession } from "@hahatalk/contracts";

export interface AuthPrincipal {
  internalUserId: string;
  sessionId: string;
  state: AuthSession;
}

export interface CreatedAuthSession {
  cookieToken: string;
  principal: AuthPrincipal;
}
