// /api/security/totp — 2FA setup/management for the current authenticated
// user. Not admin-gated: every user manages their own 2FA independently.

import type { AppContext } from "../context.ts";
import type { SessionRow } from "../db/repositories/sessions.ts";
import {
  TotpAlreadyEnabledError,
  TotpInvalidCodeError,
  TotpNotEnabledError,
  TotpNotPendingError,
  TotpService,
} from "../services/totp-service.ts";
import { apiError, mapBodyReadError, ok, readJson } from "./api-helpers.ts";

function mapTotpError(error: unknown, requestId: string): Response | null {
  if (error instanceof TotpAlreadyEnabledError) {
    return apiError("TOTP_ALREADY_ENABLED", "2FA sudah aktif.", 409, requestId);
  }
  if (error instanceof TotpNotPendingError) {
    return apiError("TOTP_NOT_PENDING", "Tidak ada setup 2FA yang menunggu konfirmasi.", 409, requestId);
  }
  if (error instanceof TotpNotEnabledError) {
    return apiError("TOTP_NOT_ENABLED", "2FA belum aktif.", 409, requestId);
  }
  if (error instanceof TotpInvalidCodeError) {
    return apiError("TOTP_INVALID_CODE", "Kode tidak valid.", 400, requestId);
  }
  return null;
}

async function readCode(
  ctx: AppContext,
  req: Request,
  requestId: string,
): Promise<{ value: string | null; response: Response | null }> {
  let body: { code?: unknown } | null;
  try {
    body = await readJson<{ code?: unknown }>(ctx, req);
  } catch (error) {
    const mapped = mapBodyReadError(error, requestId);
    if (mapped) return { value: null, response: mapped };
    throw error;
  }
  if (typeof body?.code !== "string" || !body.code.trim()) {
    return { value: null, response: apiError("INVALID", "code wajib diisi.", 400, requestId) };
  }
  return { value: body.code.trim(), response: null };
}

export async function handleSecurityTotp(
  ctx: AppContext,
  req: Request,
  session: SessionRow,
  requestId: string,
  rest: string,
): Promise<Response> {
  const service = new TotpService(ctx);

  if (rest === "" || rest === "/") {
    if (req.method === "GET") return ok(service.status(session.user_id), requestId);
    return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
  }

  if (rest === "/setup" && req.method === "POST") {
    const user = ctx.repos.users.findById(session.user_id);
    if (!user) return apiError("NOT_FOUND", "User tidak ditemukan.", 404, requestId);
    try {
      return ok(service.startSetup(session.user_id, user.email), requestId);
    } catch (error) {
      const mapped = mapTotpError(error, requestId);
      if (mapped) return mapped;
      throw error;
    }
  }

  if (rest === "/confirm" && req.method === "POST") {
    const decision = ctx.rateLimits.take("mfaVerify", session.user_id);
    if (!decision.allowed) return apiError("RATE_LIMITED", "Terlalu banyak percobaan. Coba lagi nanti.", 429, requestId);
    const parsed = await readCode(ctx, req, requestId);
    if (parsed.response) return parsed.response;
    try {
      const recoveryCodes = service.confirmSetup(session.user_id, parsed.value!);
      ctx.repos.audit.record({ userId: session.user_id, action: "auth.totp.enable", requestId, statusCode: 200 });
      return ok({ recoveryCodes }, requestId);
    } catch (error) {
      const mapped = mapTotpError(error, requestId);
      if (mapped) return mapped;
      throw error;
    }
  }

  if (rest === "/disable" && req.method === "POST") {
    const decision = ctx.rateLimits.take("mfaVerify", session.user_id);
    if (!decision.allowed) return apiError("RATE_LIMITED", "Terlalu banyak percobaan. Coba lagi nanti.", 429, requestId);
    const parsed = await readCode(ctx, req, requestId);
    if (parsed.response) return parsed.response;
    try {
      service.disable(session.user_id, parsed.value!);
      ctx.repos.audit.record({ userId: session.user_id, action: "auth.totp.disable", requestId, statusCode: 200 });
      return ok({ disabled: true }, requestId);
    } catch (error) {
      const mapped = mapTotpError(error, requestId);
      if (mapped) return mapped;
      throw error;
    }
  }

  if (rest === "/recovery-codes" && req.method === "POST") {
    const decision = ctx.rateLimits.take("mfaVerify", session.user_id);
    if (!decision.allowed) return apiError("RATE_LIMITED", "Terlalu banyak percobaan. Coba lagi nanti.", 429, requestId);
    const parsed = await readCode(ctx, req, requestId);
    if (parsed.response) return parsed.response;
    if (!service.status(session.user_id).enabled) {
      return apiError("TOTP_NOT_ENABLED", "2FA belum aktif.", 409, requestId);
    }
    if (!service.verifyCodeOrRecovery(session.user_id, parsed.value!)) {
      return apiError("TOTP_INVALID_CODE", "Kode tidak valid.", 400, requestId);
    }
    const recoveryCodes = service.regenerateRecoveryCodes(session.user_id);
    ctx.repos.audit.record({
      userId: session.user_id,
      action: "auth.totp.recovery_codes.regenerate",
      requestId,
      statusCode: 200,
    });
    return ok({ recoveryCodes }, requestId);
  }

  return apiError("NOT_FOUND", "Endpoint tidak ditemukan.", 404, requestId);
}
