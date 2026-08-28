// /api/security/kms — customer master keys for server-side encryption.
//
// Keys belong to a user, so every handler scopes by session; there is no
// cross-user key browsing.

import type { AppContext } from "../context.ts";
import type { SessionRow } from "../db/repositories/sessions.ts";
import { apiError, mapBodyReadError, ok, readJson } from "./api-helpers.ts";
import { KmsAliasConflictError } from "../db/repositories/kms-keys.ts";
import { KmsKeyNotFoundError } from "../security/kms.ts";
import type { KmsKeyRow } from "../db/repositories/kms-keys.ts";

/** Never expose key material, not even in its encrypted form. */
function keyView(ctx: AppContext, row: KmsKeyRow) {
  return {
    id: row.id,
    alias: row.alias,
    version: row.version,
    status: row.status,
    rotatedAt: row.rotated_at,
    createdAt: row.created_at,
    objectCount: ctx.repos.kmsKeys.objectCount(row.id),
  };
}

const ALIAS_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,127}$/;

export async function handleSecurityKms(
  ctx: AppContext,
  req: Request,
  session: SessionRow,
  requestId: string,
  rest: string,
): Promise<Response> {
  const userId = session.user_id;
  const segments = rest.replace(/^\//, "").split("/").filter(Boolean);

  if (segments.length === 0) {
    if (req.method === "GET") {
      return ok(ctx.kms.list(userId).map((row) => keyView(ctx, row)), requestId);
    }
    if (req.method === "POST") {
      let body;
      try {
        body = await readJson<{ alias?: unknown }>(ctx, req);
      } catch (error) {
        const mapped = mapBodyReadError(error, requestId);
        if (mapped) return mapped;
        throw error;
      }
      const alias = body?.alias;
      if (typeof alias !== "string" || !ALIAS_PATTERN.test(alias)) {
        return apiError("INVALID", "Alias key tidak valid.", 400, requestId);
      }
      try {
        const created = ctx.kms.create({ userId, alias });
        ctx.repos.audit.record({
          userId,
          action: "kms.key.create",
          statusCode: 201,
          requestId,
          detail: { alias, kmsKeyId: created.id },
        });
        return ok(keyView(ctx, created), requestId, 201);
      } catch (error) {
        if (error instanceof KmsAliasConflictError) {
          return apiError("CONFLICT", "Alias key sudah dipakai.", 409, requestId);
        }
        throw error;
      }
    }
    return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
  }

  const kmsKeyId = segments[0]!;

  if (segments[1] === "rotate" && req.method === "POST") {
    try {
      const rotated = ctx.kms.rotate(userId, kmsKeyId);
      ctx.repos.audit.record({
        userId,
        action: "kms.key.rotate",
        statusCode: 200,
        requestId,
        detail: { kmsKeyId, version: rotated.version },
      });
      return ok(keyView(ctx, rotated), requestId);
    } catch (error) {
      if (error instanceof KmsKeyNotFoundError) {
        return apiError("NOT_FOUND", "Key tidak ditemukan.", 404, requestId);
      }
      throw error;
    }
  }

  if (segments.length === 1 && req.method === "PATCH") {
    let body;
    try {
      body = await readJson<{ status?: unknown }>(ctx, req);
    } catch (error) {
      const mapped = mapBodyReadError(error, requestId);
      if (mapped) return mapped;
      throw error;
    }
    const status = body?.status;
    if (status !== "active" && status !== "disabled") {
      return apiError("INVALID", "Status key tidak valid.", 400, requestId);
    }
    try {
      const updated = ctx.kms.setStatus(userId, kmsKeyId, status);
      ctx.repos.audit.record({
        userId,
        action: "kms.key.status",
        statusCode: 200,
        requestId,
        detail: { kmsKeyId, status },
      });
      return ok(keyView(ctx, updated), requestId);
    } catch (error) {
      if (error instanceof KmsKeyNotFoundError) {
        return apiError("NOT_FOUND", "Key tidak ditemukan.", 404, requestId);
      }
      throw error;
    }
  }

  return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
}
