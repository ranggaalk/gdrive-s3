// /api/credentials — list, create, rotate, revoke, and revoked-only delete.

import type { AppContext } from "../context.ts";
import type { SessionRow } from "../db/repositories/sessions.ts";
import {
  CredentialNotFoundError,
  CredentialStateError,
  normalizeLabel,
} from "../services/credential-service.ts";
import { apiError, mapBodyReadError, ok, readJson } from "./api-helpers.ts";

export async function handleCredentials(
  ctx: AppContext,
  req: Request,
  session: SessionRow,
  requestId: string,
  rest: string,
): Promise<Response> {
  if (rest === "" || rest === "/") {
    if (req.method === "GET") {
      return ok(ctx.credentialService.list(session.user_id), requestId);
    }
    if (req.method === "POST") {
      const decision = ctx.rateLimits.take("credentialCreate", session.user_id);
      if (!decision.allowed) {
        return apiError(
          "RATE_LIMITED",
          "Terlalu banyak permintaan pembuatan kredensial. Coba lagi nanti.",
          429,
          requestId,
        );
      }
      const parsedLabel = await readLabel(ctx, req, requestId);
      if (parsedLabel.response) return parsedLabel.response;
      const created = ctx.credentialService.createAudited(
        session.user_id,
        parsedLabel.value!,
        requestId,
      );
      return secretResponse(ctx, created, requestId, 201);
    }
    return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
  }

  const segments = rest.replace(/^\//, "").split("/");
  if (segments.length < 1 || segments.length > 2 || !segments[0]) {
    return apiError("NOT_FOUND", "Endpoint tidak ditemukan.", 404, requestId);
  }
  const id = segments[0];
  const action = segments[1];

  try {
    if (action === "rotate" && req.method === "POST") {
      const created = ctx.credentialService.rotateActive(session.user_id, id, requestId);
      return secretResponse(ctx, created, requestId, 201);
    }
    if (action === "revoke" && req.method === "POST") {
      ctx.credentialService.revokeActive(session.user_id, id, requestId);
      return ok({ id, status: "revoked" }, requestId);
    }
    if (!action && req.method === "DELETE") {
      ctx.credentialService.deleteRevoked(session.user_id, id, requestId);
      return ok({ id, deleted: true }, requestId);
    }
  } catch (error) {
    if (error instanceof CredentialNotFoundError) {
      return apiError("NOT_FOUND", "Kredensial tidak ditemukan.", 404, requestId);
    }
    if (error instanceof CredentialStateError) {
      return apiError("INVALID_STATE", "Status kredensial tidak sesuai untuk operasi ini.", 409, requestId);
    }
    throw error;
  }

  return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
}

async function readLabel(
  ctx: AppContext,
  req: Request,
  requestId: string,
): Promise<{ value: string | null; response: Response | null }> {
  let body: { label?: unknown } | null;
  try {
    body = await readJson<{ label?: unknown }>(ctx, req);
  } catch (error) {
    const mapped = mapBodyReadError(error, requestId);
    if (mapped) return { value: null, response: mapped };
    throw error;
  }
  if (typeof body?.label !== "string") {
    return {
      value: null,
      response: apiError("INVALID", "Label kredensial wajib berupa teks.", 400, requestId),
    };
  }
  try {
    return { value: normalizeLabel(body.label), response: null };
  } catch {
    return {
      value: null,
      response: apiError(
        "INVALID",
        "Label wajib diisi dan maksimal 100 karakter.",
        400,
        requestId,
      ),
    };
  }
}

function secretResponse(
  ctx: AppContext,
  created: import("../services/credential-service.ts").CreatedCredential,
  requestId: string,
  status: number,
): Response {
  const response = ok(
    {
      ...created,
      s3Endpoint: ctx.config.s3PublicEndpoint,
      s3Region: ctx.config.s3Region,
    },
    requestId,
    status,
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
}
