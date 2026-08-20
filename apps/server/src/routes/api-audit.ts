// /api/audit — recent activity for the signed-in user (newest first).

import type { AppContext } from "../context.ts";
import type { SessionRow } from "../db/repositories/sessions.ts";
import { apiError, ok } from "./api-helpers.ts";

export function handleAudit(
  ctx: AppContext,
  req: Request,
  session: SessionRow,
  requestId: string,
): Response {
  if (req.method !== "GET") {
    return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
  }
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50") || 50, 200);
  const before = url.searchParams.get("before") ?? undefined;

  const rows = ctx.repos.audit.listForUser(session.user_id, { limit, before });
  return ok(
    {
      items: rows.map((r) => ({
        id: r.id,
        action: r.action,
        bucketName: r.bucket_name,
        objectKey: r.object_key,
        statusCode: r.status_code,
        requestId: r.request_id,
        bytesIn: r.bytes_in,
        bytesOut: r.bytes_out,
        createdAt: r.created_at,
      })),
      nextBefore: rows.length === limit ? rows[rows.length - 1]?.created_at : null,
    },
    requestId,
  );
}
