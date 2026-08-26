// /api/traffic — dashboard-wide overview, summed across every bucket the
// signed-in user can access (owner or member), not just buckets they own.

import type { AppContext } from "../context.ts";
import type { SessionRow } from "../db/repositories/sessions.ts";
import { apiError, ok } from "./api-helpers.ts";
import { resolveTrafficWindow } from "./traffic-range.ts";

export function handleTraffic(
  ctx: AppContext,
  req: Request,
  session: SessionRow,
  requestId: string,
): Response {
  if (req.method !== "GET") {
    return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
  }
  const range = new URL(req.url).searchParams.get("range") ?? "1h";
  const window = resolveTrafficWindow(range);
  if (!window) return apiError("INVALID", "range harus salah satu dari: 1h, 24h, 7d.", 400, requestId);

  const bucketIds = ctx.bucketAccess.list(session.user_id).map((b) => b.id);
  const since = new Date(Date.now() - window.windowMs);
  const points = ctx.repos.audit.trafficSeriesForBuckets(bucketIds, since, window.granularity);
  return ok({ range, granularity: window.granularity, points }, requestId);
}
