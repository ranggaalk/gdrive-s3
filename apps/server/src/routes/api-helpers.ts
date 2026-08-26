// Shared helpers for control-plane route handlers.

import type { AppContext } from "../context.ts";
import type { SessionRow } from "../db/repositories/sessions.ts";
import { readCookie, SESSION_COOKIE } from "../auth/session.ts";
import { CSRF_HEADER, requiresCsrf, verifyCsrf } from "../security/csrf.ts";
import { hasAllowedOrigin } from "../security/origin.ts";
import { BodyTooLargeError, readBoundedJson } from "../util/body-size.ts";

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function ok(data: unknown, requestId: string, status = 200): Response {
  return json({ data, requestId }, status);
}

export function apiError(
  code: string,
  message: string,
  status: number,
  requestId: string,
): Response {
  return json({ error: { code, message }, requestId }, status);
}

export interface Authed {
  session: SessionRow;
}

/** Resolve the session and enforce CSRF on mutating methods. */
export function authenticate(
  ctx: AppContext,
  req: Request,
  requestId: string,
): Authed | Response {
  const rawId = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
  const session = ctx.sessionService.resolve(rawId);
  if (!session) {
    return apiError("UNAUTHENTICATED", "Sesi tidak valid atau kedaluwarsa.", 401, requestId);
  }
  const user = ctx.repos.users.findById(session.user_id);
  if (!user || user.status !== "active") {
    return apiError("UNAUTHENTICATED", "Akun tidak aktif.", 401, requestId);
  }
  if (session.mfa_pending) {
    return apiError("MFA_REQUIRED", "Verifikasi 2FA belum selesai.", 401, requestId);
  }
  if (requiresCsrf(req.method)) {
    if (!hasAllowedOrigin(req, ctx.config)) {
      return apiError("CSRF_FAILED", "Origin permintaan tidak diizinkan.", 403, requestId);
    }
    if (!verifyCsrf(session.csrf_secret, req.headers.get(CSRF_HEADER))) {
      return apiError("CSRF_FAILED", "Token CSRF tidak valid.", 403, requestId);
    }
  }
  return { session };
}

/** Parse a bounded JSON body; returns null on syntax failure. */
export async function readJson<T>(ctx: AppContext, req: Request): Promise<T | null> {
  return readBoundedJson<T>(req, ctx.config.maxControlJsonBytes);
}

export function mapBodyReadError(error: unknown, requestId: string): Response | null {
  if (!(error instanceof BodyTooLargeError)) return null;
  return apiError("PAYLOAD_TOO_LARGE", "Body permintaan terlalu besar.", 413, requestId);
}
