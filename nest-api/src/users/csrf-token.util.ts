import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

/**
 * Per-session CSRF token, ported from pfa unchanged. The token lives in the
 * session (server side, in Redis) and must be echoed in a header — a cookie
 * alone is not proof of intent, since the browser attaches it to any request.
 */

const CSRF_TOKEN_SIZE_BYTES = 32;
const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_HEADER_CANDIDATES = ["x-csrf-token", "x-xsrf-token"] as const;

interface SessionState {
  userId?: string;
  csrfToken?: string;
}

function getSessionState(req: Request): SessionState {
  return (req.session as SessionState | undefined) ?? {};
}

function createCsrfToken(): string {
  return randomBytes(CSRF_TOKEN_SIZE_BYTES).toString("hex");
}

function timingSafeTokenCompare(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

function readCsrfHeader(req: Request): string | undefined {
  for (const headerName of CSRF_HEADER_CANDIDATES) {
    const value = req.header(headerName);
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function isSafeHttpMethod(method: string): boolean {
  return SAFE_HTTP_METHODS.has(method.toUpperCase());
}

export function hasAuthenticatedSession(req: Request): boolean {
  return typeof getSessionState(req).userId === "string";
}

export function rotateCsrfToken(req: Request): string {
  const token = createCsrfToken();
  getSessionState(req).csrfToken = token;
  return token;
}

export function getOrCreateCsrfToken(req: Request): string {
  const session = getSessionState(req);
  if (!session.csrfToken) {
    session.csrfToken = createCsrfToken();
  }
  return session.csrfToken;
}

export function clearCsrfToken(req: Request): void {
  delete getSessionState(req).csrfToken;
}

export function hasValidCsrfToken(req: Request): boolean {
  const sessionToken = getSessionState(req).csrfToken;
  const headerToken = readCsrfHeader(req);

  if (!sessionToken || !headerToken) {
    return false;
  }

  return timingSafeTokenCompare(sessionToken, headerToken);
}
