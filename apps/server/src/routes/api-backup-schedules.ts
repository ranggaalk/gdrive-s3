// /api/backup-schedules: scheduled backups, one per (bucket, destination)
// pair. Only a bucket's owner can schedule it, and only to a destination they
// own -- the same rule a manual run follows.

import type { AppContext } from "../context.ts";
import type { SessionRow } from "../db/repositories/sessions.ts";
import type { BackupScheduleListRow } from "../db/repositories/backup-schedules.ts";
import { BackupScheduleExistsError } from "../db/repositories/backup-schedules.ts";
import { BackupAlreadyActiveError } from "../db/repositories/backup-transfers.ts";
import { ScheduleInputError } from "../backup/schedule-time.ts";
import { BackupScheduleNotFoundError, BackupScheduleService } from "../services/backup-schedule-service.ts";
import { BackupTransferInvalidError } from "../services/backup-transfer-service.ts";
import { apiError, mapBodyReadError, ok, readJson } from "./api-helpers.ts";

function scheduleView(s: BackupScheduleListRow) {
  return {
    id: s.id,
    bucketId: s.bucket_id,
    bucketName: s.bucket_name,
    backupAccountId: s.backup_account_id,
    accountLabel: s.account_label,
    accountKind: s.account_kind,
    enabled: s.enabled === 1,
    frequency: s.frequency,
    intervalMinutes: s.interval_minutes,
    timeOfDay: s.time_of_day,
    daysOfWeek: s.days_of_week ? s.days_of_week.split(",").map(Number) : null,
    timezone: s.timezone,
    quietMinutes: s.quiet_minutes,
    maxWaitMinutes: s.max_wait_minutes,
    pendingSince: s.pending_since,
    skipIfUnchanged: s.skip_if_unchanged === 1,
    nextRunAt: s.next_run_at,
    lastCheckedAt: s.last_checked_at,
    lastOutcome: s.last_outcome,
    lastTransferId: s.last_transfer_id,
    lastTransferStatus: s.last_transfer_status,
    consecutiveFailures: s.consecutive_failures,
    pausedReason: s.paused_reason,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

function scheduleError(error: unknown, requestId: string): Response | null {
  if (error instanceof ScheduleInputError) {
    return apiError("INVALID_BACKUP_SCHEDULE", "Pengaturan jadwal backup tidak valid.", 400, requestId, error.message);
  }
  if (error instanceof BackupScheduleExistsError) {
    return apiError("BACKUP_SCHEDULE_EXISTS", "Bucket ini sudah punya jadwal ke tujuan itu.", 409, requestId);
  }
  if (error instanceof BackupScheduleNotFoundError) {
    return apiError("NOT_FOUND", "Jadwal backup tidak ditemukan.", 404, requestId);
  }
  if (error instanceof BackupAlreadyActiveError) {
    return apiError("BACKUP_ACTIVE", "Masih ada backup aktif untuk tujuan ini.", 409, requestId);
  }
  if (error instanceof BackupTransferInvalidError) {
    return apiError("INVALID_BACKUP_TARGET", error.message, 400, requestId);
  }
  return null;
}

async function readBody(ctx: AppContext, req: Request, requestId: string): Promise<{ body: unknown } | Response> {
  try {
    return { body: await readJson<unknown>(ctx, req) };
  } catch (error) {
    const mapped = mapBodyReadError(error, requestId);
    if (mapped) return mapped;
    throw error;
  }
}

export async function handleBackupSchedules(
  ctx: AppContext,
  req: Request,
  session: SessionRow,
  requestId: string,
  rest: string,
): Promise<Response> {
  const userId = session.user_id;
  const service = new BackupScheduleService(ctx);
  const segments = rest.replace(/^\//, "").split("/").filter(Boolean);
  const view = (id: string) => scheduleView(ctx.repos.backupSchedules.findOwnedListRow(userId, id)!);

  try {
    if (segments.length === 0) {
      if (req.method === "GET") {
        const bucketId = new URL(req.url).searchParams.get("bucketId") ?? undefined;
        return ok(ctx.repos.backupSchedules.listForUser(userId, { bucketId }).map(scheduleView), requestId);
      }
      if (req.method === "POST") {
        const read = await readBody(ctx, req, requestId);
        if (read instanceof Response) return read;
        const schedule = service.create(userId, read.body);
        ctx.repos.audit.record({
          userId,
          action: "backup.schedule.create",
          bucketId: schedule.bucket_id,
          requestId,
          statusCode: 201,
          detail: { backupScheduleId: schedule.id, backupAccountId: schedule.backup_account_id },
        });
        return ok(view(schedule.id), requestId, 201);
      }
      return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
    }

    // Schedule ids all start with "bks_", so this never shadows one.
    if (segments.length === 1 && segments[0] === "options") {
      if (req.method !== "GET") return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
      const settings = ctx.config.backupScheduler;
      return ok({ enabled: settings.enabled, minIntervalMinutes: settings.minIntervalMinutes }, requestId);
    }

    const id = segments[0]!;
    if (segments.length === 1 && req.method === "PATCH") {
      const read = await readBody(ctx, req, requestId);
      if (read instanceof Response) return read;
      const schedule = service.update(userId, id, read.body);
      ctx.repos.audit.record({
        userId,
        action: "backup.schedule.update",
        bucketId: schedule.bucket_id,
        requestId,
        statusCode: 200,
        detail: { backupScheduleId: id, enabled: schedule.enabled === 1 },
      });
      return ok(view(id), requestId);
    }
    if (segments.length === 1 && req.method === "DELETE") {
      service.delete(userId, id);
      ctx.repos.audit.record({
        userId,
        action: "backup.schedule.delete",
        requestId,
        statusCode: 200,
        detail: { backupScheduleId: id },
      });
      return ok({ id, deleted: true }, requestId);
    }
    if (segments.length === 2 && segments[1] === "run" && req.method === "POST") {
      const transfer = await service.runNow(userId, id);
      ctx.repos.audit.record({
        userId,
        action: "backup.transfer.create",
        bucketId: transfer.bucket_id,
        requestId,
        statusCode: 202,
        detail: { backupTransferId: transfer.id, backupScheduleId: id },
      });
      return ok({ transferId: transfer.id, schedule: view(id) }, requestId, 202);
    }
    return apiError("NOT_FOUND", "Endpoint tidak ditemukan.", 404, requestId);
  } catch (error) {
    const mapped = scheduleError(error, requestId);
    if (mapped) return mapped;
    throw error;
  }
}
