import type { AuthSession, MobileAuthView } from "@hahatalk/contracts";

export interface AuthPrincipal {
  internalUserId: string;
  sessionId: string;
  sessionKind: "mobile" | "web";
  mobileInstallationHash?: string;
  state: AuthSession;
}

export interface CreatedAuthSession {
  cookieToken: string;
  principal: AuthPrincipal;
}

export interface CreatedMobileAuthSession extends MobileAuthView {
  principal: AuthPrincipal;
}
