// /api/backup-accounts (link management) and bucket-scoped
// /api/buckets/:id/backups (manual transfer runs).

import type { AppContext } from "../context.ts";
import type { SessionRow } from "../db/repositories/sessions.ts";
import type { BackupAccountRow } from "../db/repositories/backup-accounts.ts";
import type {
  BackupObjectStatus,
  BackupObjectStatusRow,
  BackupTransferHistoryRow,
  BackupTransferRow,
  BackupTransferStatus,
} from "../db/repositories/backup-transfers.ts";
import {
  BackupAlreadyActiveError,
  encodeHistoryCursor,
  parseHistoryCursor,
} from "../db/repositories/backup-transfers.ts";
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

// ---------------------------------------------------------------------------
// /api/backups — history across every bucket, and the detail behind one run.
//
// The per-bucket endpoints above answer "what happened to this bucket"; these
// answer "what has this gateway backed up, and where did each object land".
// Every query is scoped by backup_transfers.user_id, so a run is only ever
// visible to the owner who started it.

const TRANSFER_STATUSES: readonly BackupTransferStatus[] = [
  "queued",
  "running",
  "cancel_requested",
  "completed",
  "cancelled",
  "failed",
];

const DEFAULT_HISTORY_LIMIT = 25;
const MAX_HISTORY_LIMIT = 100;

function readLimit(url: URL): number {
  const raw = Number(url.searchParams.get("limit"));
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_HISTORY_LIMIT;
  return Math.min(Math.floor(raw), MAX_HISTORY_LIMIT);
}

function historyView(t: BackupTransferHistoryRow) {
  return {
    ...transferView(t),
    bucketName: t.bucket_name,
    accountEmail: t.account_email,
    startedAt: t.started_at,
    updatedAt: t.updated_at,
  };
}

function ledgerView(row: BackupObjectStatusRow) {
  return {
    objectId: row.object_id,
    objectKey: row.object_key,
    objectEtag: row.object_etag,
    status: row.status,
    destinationFileId: row.destination_file_id,
    attempts: row.attempts,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

export function handleBackupHistory(
  ctx: AppContext,
  req: Request,
  session: SessionRow,
  requestId: string,
  rest: string,
): Response {
  if (req.method !== "GET") {
    return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
  }
  const userId = session.user_id;
  const url = new URL(req.url);
  const segments = rest.replace(/^\//, "").split("/").filter(Boolean);

  if (segments.length === 0) {
    const status = url.searchParams.get("status");
    if (status && !TRANSFER_STATUSES.includes(status as BackupTransferStatus)) {
      return apiError("INVALID", "Status backup tidak dikenal.", 400, requestId);
    }
    const limit = readLimit(url);
    const rows = ctx.repos.backupTransfers.listForUser(userId, {
      limit,
      before: parseHistoryCursor(url.searchParams.get("before")),
      backupAccountId: url.searchParams.get("accountId") ?? undefined,
      bucketId: url.searchParams.get("bucketId") ?? undefined,
      status: (status as BackupTransferStatus | null) ?? undefined,
    });
    const last = rows[rows.length - 1];
    return ok(
      {
        items: rows.map(historyView),
        nextBefore:
          rows.length === limit && last
            ? encodeHistoryCursor({ at: last.created_at, id: last.id })
            : null,
      },
      requestId,
    );
  }

  // Must be matched before the /:id branch, or a run could never be named
  // "summary" without shadowing it.
  if (segments.length === 1 && segments[0] === "summary") {
    const accounts = ctx.repos.backupAccounts.listByOwner(userId);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const summaries = ctx.repos.backupTransfers.summarizeByAccount(userId);
    return ok(
      {
        totals: {
          accounts: accounts.length,
          runs: summaries.reduce((sum, s) => sum + s.runs, 0),
          activeRuns: summaries.reduce((sum, s) => sum + s.active_runs, 0),
          copied: summaries.reduce((sum, s) => sum + s.copied_total, 0),
          skipped: summaries.reduce((sum, s) => sum + s.skipped_total, 0),
          failed: summaries.reduce((sum, s) => sum + s.failed_total, 0),
          objectsOnRecord: summaries.reduce((sum, s) => sum + s.objects_on_record, 0),
        },
        accounts: summaries.map((s) => ({
          backupAccountId: s.backup_account_id,
          email: byId.get(s.backup_account_id)?.email ?? s.backup_account_id,
          accountStatus: byId.get(s.backup_account_id)?.status ?? "error",
          runs: s.runs,
          activeRuns: s.active_runs,
          lastRunAt: s.last_run_at,
          lastStatus: s.last_status,
          copiedTotal: s.copied_total,
          skippedTotal: s.skipped_total,
          failedTotal: s.failed_total,
          objectsOnRecord: s.objects_on_record,
        })),
      },
      requestId,
    );
  }

  const transferId = segments[0]!;
  const transfer = ctx.repos.backupTransfers.findOwnedHistory(userId, transferId);
  if (!transfer) return apiError("NOT_FOUND", "Backup tidak ditemukan.", 404, requestId);

  if (segments.length === 1) {
    const ledger = ctx.repos.backupTransfers.countTransferObjects(transferId);
    return ok(
      {
        ...historyView(transfer),
        // What the ledger still attributes to this run. A later run that
        // re-copied the same object takes its line over, so an older run's
        // ledger counts legitimately fall below its own counters.
        ledger: { copied: ledger.copied, failed: ledger.failed },
      },
      requestId,
    );
  }

  if (segments.length === 2 && segments[1] === "objects") {
    const status = url.searchParams.get("status");
    if (status && status !== "copied" && status !== "failed") {
      return apiError("INVALID", "Status objek backup tidak dikenal.", 400, requestId);
    }
    const limit = readLimit(url);
    const rows = ctx.repos.backupTransfers.listTransferObjects(transferId, {
      limit,
      before: parseHistoryCursor(url.searchParams.get("before")),
      status: (status as BackupObjectStatus | null) ?? undefined,
    });
    const last = rows[rows.length - 1];
    return ok(
      {
        items: rows.map(ledgerView),
        nextBefore:
          rows.length === limit && last
            ? encodeHistoryCursor({ at: last.updated_at, id: last.object_id })
            : null,
      },
      requestId,
    );
  }

  return apiError("NOT_FOUND", "Endpoint tidak ditemukan.", 404, requestId);
}
