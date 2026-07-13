import type { NextFunction, Request, Response } from "express";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
export const hahaTalkClientHeader = "X-HahaTalk-Client";
export const hahaTalkClientHeaderValue = "web-v1";

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

    const origin = request.headers.origin;
    const clientHeader = request.header(hahaTalkClientHeader);
    const fetchSite = request.header("Sec-Fetch-Site");
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
