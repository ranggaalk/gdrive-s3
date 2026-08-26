// Login-time 2FA verification. Deliberately outside /api/* dispatch (see
// index.ts) — api-helpers.ts's authenticate() rejects any session still
// mfa_pending, and these two routes are exactly the exception to that: they
// operate on a pending session to either report its state or clear it.

import type { AppContext } from "../context.ts";
import { readCookie, SESSION_COOKIE } from "../auth/session.ts";
import { CSRF_HEADER, requiresCsrf, verifyCsrf } from "../security/csrf.ts";
import { hasAllowedOrigin } from "../security/origin.ts";
import { TotpService } from "../services/totp-service.ts";
import { apiError, mapBodyReadError, ok, readJson } from "./api-helpers.ts";

export async function handleMfaStatus(ctx: AppContext, req: Request, requestId: string): Promise<Response> {
  const rawId = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
  const session = ctx.sessionService.resolve(rawId);
  if (!session) return apiError("UNAUTHENTICATED", "Sesi tidak valid atau kedaluwarsa.", 401, requestId);
  return ok({ pending: !!session.mfa_pending, csrfToken: session.csrf_secret }, requestId);
}

export async function handleMfaVerify(ctx: AppContext, req: Request, requestId: string): Promise<Response> {
  const rawId = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
  const session = ctx.sessionService.resolve(rawId);
  if (!session || !session.mfa_pending) {
    return apiError("NOT_PENDING", "Tidak ada verifikasi 2FA yang menunggu.", 400, requestId);
  }
  if (requiresCsrf(req.method)) {
    if (!hasAllowedOrigin(req, ctx.config)) {
      return apiError("CSRF_FAILED", "Origin permintaan tidak diizinkan.", 403, requestId);
    }
    if (!verifyCsrf(session.csrf_secret, req.headers.get(CSRF_HEADER))) {
      return apiError("CSRF_FAILED", "Token CSRF tidak valid.", 403, requestId);
    }
  }
  const decision = ctx.rateLimits.take("mfaVerify", session.user_id);
  if (!decision.allowed) {
    return apiError("RATE_LIMITED", "Terlalu banyak percobaan. Coba lagi nanti.", 429, requestId);
  }
  let body: { code?: unknown } | null;
  try {
    body = await readJson<{ code?: unknown }>(ctx, req);
  } catch (error) {
    const mapped = mapBodyReadError(error, requestId);
    if (mapped) return mapped;
    throw error;
  }
  if (typeof body?.code !== "string" || !body.code.trim()) {
    return apiError("INVALID", "Kode wajib diisi.", 400, requestId);
  }
  const verified = new TotpService(ctx).verifyCodeOrRecovery(session.user_id, body.code);
  if (!verified) {
    return apiError("INVALID_CODE", "Kode salah atau sudah kedaluwarsa.", 401, requestId);
  }
  ctx.repos.sessions.markMfaVerified(session.id_hash);
  ctx.repos.audit.record({
    userId: session.user_id,
    action: "auth.mfa.verify",
    requestId,
    statusCode: 200,
  });
  return ok({ ok: true }, requestId);
}
