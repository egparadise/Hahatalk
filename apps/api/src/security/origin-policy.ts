import type { NextFunction, Request, Response } from "express";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
export const hahaTalkClientHeader = "X-HahaTalk-Client";
export const hahaTalkClientHeaderValue = "web-v1";
export const hahaTalkMobileClientHeaderValue = "mobile-v1";

export function createOriginPolicy(allowedOrigin: string) {
  const normalizedAllowedOrigin = new URL(allowedOrigin).origin;

  return (request: Request, response: Response, next: NextFunction) => {
    if (safeMethods.has(request.method.toUpperCase())) {
      next();
      return;
    }

    if (
      request.path === "/provider/livekit/webhook"
      && request.header("Content-Type")?.toLowerCase().startsWith("application/webhook+json")
      && Boolean(request.header("Authorization"))
    ) {
      next();
      return;
    }

    if (
      request.path.startsWith("/internal/ai/")
      && Boolean(request.header("X-HahaTalk-AI-Worker-Token"))
    ) {
      next();
      return;
    }

    if (
      request.path.startsWith("/internal/remote-support/")
      && (
        request.header("X-HahaTalk-Remote-Agent") === "agent-v1"
        || Boolean(request.header("X-HahaTalk-Remote-Agent-Token"))
      )
    ) {
      next();
      return;
    }

    if (
      request.path.startsWith("/internal/mobile/push/")
      && Boolean(request.header("X-HahaTalk-Mobile-Worker-Token"))
    ) {
      next();
      return;
    }

    const origin = request.headers.origin;
    const fetchSite = request.header("Sec-Fetch-Site");
    const clientHeader = request.header(hahaTalkClientHeader);
    const isExactMobilePublicAuth = request.method.toUpperCase() === "POST"
      && ["/auth/mobile/login", "/auth/mobile/refresh"].includes(request.path);
    const hasMobileBearer = /^Bearer hha_[A-Za-z0-9_-]{40,150}$/.test(request.header("Authorization") ?? "");
    if (
      clientHeader === hahaTalkMobileClientHeaderValue
      && !origin
      && !fetchSite
      && (isExactMobilePublicAuth || hasMobileBearer)
    ) {
      next();
      return;
    }

    if (
      origin !== normalizedAllowedOrigin ||
      clientHeader !== hahaTalkClientHeaderValue ||
      fetchSite === "cross-site"
    ) {
      response.status(403).json({
        error: "Forbidden",
        message: "Request origin validation failed.",
        statusCode: 403
      });
      return;
    }

    next();
  };
}
