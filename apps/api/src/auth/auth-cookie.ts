import { parse } from "cookie";
import type { CookieOptions, Response } from "express";

const defaultCookieName = "hahatalk_dev_session";

export function getSessionCookieName() {
  const cookieName = process.env.SESSION_COOKIE_NAME?.trim() || defaultCookieName;
  if (!/^[A-Za-z0-9_]+$/.test(cookieName)) {
    throw new Error("SESSION_COOKIE_NAME may contain only ASCII letters, numbers, and underscores.");
  }
  return cookieName;
}

export function getSessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    maxAge: 12 * 60 * 60 * 1_000,
    path: "/",
    sameSite: "strict",
    secure: process.env.COOKIE_SECURE === "true"
  };
}

export function readSessionToken(cookieHeader?: string) {
  if (!cookieHeader) {
    return undefined;
  }

  try {
    return parse(cookieHeader)[getSessionCookieName()];
  } catch {
    return undefined;
  }
}

export function setSessionCookie(response: Response, token: string) {
  response.cookie(getSessionCookieName(), token, getSessionCookieOptions());
}

export function clearSessionCookie(response: Response) {
  const { maxAge: _maxAge, ...options } = getSessionCookieOptions();
  response.clearCookie(getSessionCookieName(), options);
}
