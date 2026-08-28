// GET /api/drive/quota — what the Drive API will still let this gateway do.
//
// Everyone sees the observed counters, their own Drive storage quota, and the
// project's live request quota. The per-user breakdown shows how busy other
// people have been, so it is admin-only.

import type { AppContext } from "../context.ts";
import type { SessionRow } from "../db/repositories/sessions.ts";
import { apiError, ok } from "./api-helpers.ts";

export async function handleDriveQuota(
  ctx: AppContext,
  req: Request,
  session: SessionRow,
  requestId: string,
): Promise<Response> {
  if (req.method !== "GET") {
    return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
  }

  const user = ctx.repos.users.findById(session.user_id);
  const isAdmin = !!user?.is_admin;

  const snapshot = await ctx.driveQuotaService.snapshot({
    userId: session.user_id,
    includeUsers: isAdmin,
    signal: req.signal,
  });

  return ok(
    {
      ...snapshot,
      observed: {
        ...snapshot.observed,
        // Ids mean nothing in the UI; resolve the ones this gateway knows.
        users: snapshot.observed.users.map((row) => ({
          ...row,
          email: ctx.repos.users.findById(row.userId)?.email ?? null,
        })),
      },
      canSeeUsers: isAdmin,
    },
    requestId,
  );
}
