// /api/backup-accounts (link management) and bucket-scoped
// /api/buckets/:id/backups (manual transfer runs).

import type { AppContext } from "../context.ts";
import type { SessionRow } from "../db/repositories/sessions.ts";
import type { BackupAccountRow } from "../db/repositories/backup-accounts.ts";
import type { BackupTransferRow } from "../db/repositories/backup-transfers.ts";
import { BackupAlreadyActiveError } from "../db/repositories/backup-transfers.ts";
import { BackupTransferInvalidError, BackupTransferService } from "../services/backup-transfer-service.ts";
import { apiError, mapBodyReadError, ok, readJson } from "./api-helpers.ts";

function accountView(a: BackupAccountRow) {
  return {
    id: a.id,
    email: a.email,
    status: a.status,
    lastError: a.last_error,
    lastUsedAt: a.last_used_at,
    createdAt: a.created_at,
  };
}

export async function handleBackupAccounts(
  ctx: AppContext,
  req: Request,
  session: SessionRow,
  requestId: string,
  rest: string,
): Promise<Response> {
  const userId = session.user_id;

  if (rest === "" || rest === "/") {
    if (req.method === "GET") {
      return ok(ctx.repos.backupAccounts.listByOwner(userId).map(accountView), requestId);
    }
    return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
  }

  const segments = rest.replace(/^\//, "").split("/");
  const id = segments[0]!;
  if (segments.length === 1 && req.method === "DELETE") {
    const deleted = ctx.repos.backupAccounts.delete(userId, id);
    if (!deleted) return apiError("NOT_FOUND", "Akun backup tidak ditemukan.", 404, requestId);
    ctx.repos.audit.record({
      userId,
      action: "backup.account.unlink",
      requestId,
      statusCode: 200,
      detail: { backupAccountId: id },
    });
    return ok({ id, deleted: true }, requestId);
  }

  return apiError("NOT_FOUND", "Endpoint tidak ditemukan.", 404, requestId);
}

function transferView(t: BackupTransferRow) {
  return {
    id: t.id,
    bucketId: t.bucket_id,
    backupAccountId: t.backup_account_id,
    status: t.status,
    total: t.total_count,
    skipped: t.skipped_count,
    copied: t.copied_count,
    failed: t.failed_count,
    lastError: t.last_error,
    createdAt: t.created_at,
    completedAt: t.completed_at,
  };
}

export async function handleBucketBackups(
  ctx: AppContext,
  req: Request,
  session: SessionRow,
  requestId: string,
  bucketId: string,
  segments: string[],
): Promise<Response> {
  let owner;
  try {
    owner = ctx.bucketAccess.findById(session.user_id, bucketId, "owner");
  } catch {
    owner = null;
  }
  if (!owner) {
    return apiError("ACCESS_DENIED", "Hanya pemilik bucket yang dapat mengelola backup.", 403, requestId);
  }

  if (segments.length === 0) {
    if (req.method === "GET") {
      return ok(
        ctx.repos.backupTransfers.listByBucket(session.user_id, bucketId).map(transferView),
        requestId,
      );
    }
    if (req.method === "POST") {
      let body: { backupAccountId?: unknown } | null;
      try {
        body = await readJson<{ backupAccountId?: unknown }>(ctx, req);
      } catch (error) {
        const mapped = mapBodyReadError(error, requestId);
        if (mapped) return mapped;
        throw error;
      }
      if (typeof body?.backupAccountId !== "string" || !body.backupAccountId) {
        return apiError("INVALID", "backupAccountId wajib diisi.", 400, requestId);
      }
      try {
        const transfer = await new BackupTransferService(ctx).create({
          userId: session.user_id,
          bucketId,
          backupAccountId: body.backupAccountId,
        });
        ctx.repos.audit.record({
          userId: session.user_id,
          action: "backup.transfer.create",
          bucketName: owner.name,
          bucketId: owner.id,
          statusCode: 202,
          requestId,
          detail: { backupTransferId: transfer.id, backupAccountId: body.backupAccountId },
        });
        return ok(transferView(transfer), requestId, 202);
      } catch (error) {
        if (error instanceof BackupTransferInvalidError) {
          return apiError("INVALID_BACKUP_TARGET", error.message, 400, requestId);
        }
        if (error instanceof BackupAlreadyActiveError) {
          return apiError("BACKUP_ACTIVE", "Masih ada backup aktif untuk tujuan ini.", 409, requestId);
        }
        throw error;
      }
    }
    return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
  }

  const transferId = segments[0]!;
  if (segments.length === 1 && req.method === "GET") {
    const transfer = ctx.repos.backupTransfers.findOwned(session.user_id, bucketId, transferId);
    if (!transfer) return apiError("NOT_FOUND", "Backup tidak ditemukan.", 404, requestId);
    return ok(transferView(transfer), requestId);
  }
  if (segments[1] === "cancel" && segments.length === 2 && req.method === "POST") {
    const changed = ctx.repos.backupTransfers.requestCancel(session.user_id, bucketId, transferId);
    if (!changed) return apiError("BACKUP_TERMINAL", "Backup sudah selesai.", 409, requestId);
    return ok({ cancelled: true }, requestId);
  }
  return apiError("NOT_FOUND", "Endpoint tidak ditemukan.", 404, requestId);
}
