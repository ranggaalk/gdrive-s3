// Manual (and, later, scheduler-driven) bucket -> backup-account transfers.
//
// Unlike drive_imports, the source set is already fully known (it's this
// bucket's own `objects` table) so there is no scan phase. Progress is
// tracked two ways: aggregate counters on the transfer row (for the
// progress UI) and a durable per-object ledger, `backup_object_status`,
// keyed by (backup_account_id, object_id) and the exact etag that was
// copied — that ledger is what makes repeated runs incremental instead of
// re-uploading everything, and is the piece a future scheduler reuses.

import type { Database } from "bun:sqlite";
import type { ObjectRow } from "./objects.ts";
import { newBackupTransferId, nowIso } from "../../util/ids.ts";

export type BackupTransferStatus =
  | "queued"
  | "running"
  | "cancel_requested"
  | "completed"
  | "cancelled"
  | "failed";

export interface BackupTransferRow {
  id: string;
  bucket_id: string;
  backup_account_id: string;
  user_id: string;
  destination_folder_id: string | null;
  status: BackupTransferStatus;
  total_count: number;
  skipped_count: number;
  copied_count: number;
  failed_count: number;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export const MAX_BACKUP_ITEM_ATTEMPTS = 3;

export class BackupAlreadyActiveError extends Error {
  constructor() {
    super("A backup transfer is already active for this bucket and destination");
    this.name = "BackupAlreadyActiveError";
  }
}

export class BackupTransfersRepository {
  constructor(private readonly db: Database) {}

  findById(id: string): BackupTransferRow | null {
    return this.db.query<BackupTransferRow, [string]>("SELECT * FROM backup_transfers WHERE id = ?").get(id) ?? null;
  }

  findOwned(userId: string, bucketId: string, id: string): BackupTransferRow | null {
    return (
      this.db
        .query<BackupTransferRow, [string, string, string]>(
          "SELECT * FROM backup_transfers WHERE id = ? AND bucket_id = ? AND user_id = ?",
        )
        .get(id, bucketId, userId) ?? null
    );
  }

  listByBucket(userId: string, bucketId: string, limit = 20): BackupTransferRow[] {
    return this.db
      .query<BackupTransferRow, [string, string, number]>(
        `SELECT * FROM backup_transfers
          WHERE user_id = ? AND bucket_id = ?
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(userId, bucketId, limit);
  }

  create(input: { userId: string; bucketId: string; backupAccountId: string }): BackupTransferRow {
    const totalCount =
      this.db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM objects WHERE bucket_id = ? AND status = 'active'",
        )
        .get(input.bucketId)?.n ?? 0;
    const skippedCount =
      this.db
        .query<{ n: number }, [string, string]>(
          `SELECT COUNT(*) AS n FROM objects o
            WHERE o.bucket_id = ? AND o.status = 'active'
              AND EXISTS (
                SELECT 1 FROM backup_object_status s
                 WHERE s.backup_account_id = ? AND s.object_id = o.id
                   AND s.object_etag = o.etag AND s.status = 'copied'
              )`,
        )
        .get(input.bucketId, input.backupAccountId)?.n ?? 0;

    const id = newBackupTransferId();
    const now = nowIso();
    try {
      this.db
        .query(
          `INSERT INTO backup_transfers
             (id, bucket_id, backup_account_id, user_id, status, total_count, skipped_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
        )
        .run(id, input.bucketId, input.backupAccountId, input.userId, totalCount, skippedCount, now, now);
    } catch (error) {
      // SQLite reports a partial unique index by its column list, not its
      // name (e.g. "UNIQUE constraint failed: backup_transfers.bucket_id,
      // backup_transfers.backup_account_id"), so match on that instead.
      if (
        String(error).includes("UNIQUE constraint failed") &&
        String(error).includes("backup_transfers.bucket_id") &&
        String(error).includes("backup_transfers.backup_account_id")
      ) {
        throw new BackupAlreadyActiveError();
      }
      throw error;
    }
    return this.findById(id)!;
  }

  claimNextJob(): BackupTransferRow | null {
    let claimed: BackupTransferRow | null = null;
    const tx = this.db.transaction(() => {
      const row = this.db
        .query<BackupTransferRow, []>(
          `SELECT * FROM backup_transfers
            WHERE status IN ('queued', 'running', 'cancel_requested')
            ORDER BY CASE status
              WHEN 'cancel_requested' THEN 0
              WHEN 'queued' THEN 1
              ELSE 2
            END, updated_at ASC LIMIT 1`,
        )
        .get();
      if (!row) return;
      if (row.status === "queued") {
        const now = nowIso();
        this.db
          .query(
            `UPDATE backup_transfers
                SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
              WHERE id = ? AND status = 'queued'`,
          )
          .run(now, now, row.id);
      }
      claimed = this.db.query<BackupTransferRow, [string]>("SELECT * FROM backup_transfers WHERE id = ?").get(row.id) ?? null;
    });
    tx();
    return claimed;
  }

  setDestinationFolder(id: string, folderId: string): void {
    this.db
      .query("UPDATE backup_transfers SET destination_folder_id = ?, updated_at = ? WHERE id = ?")
      .run(folderId, nowIso(), id);
  }

  /** Objects still needing a copy for this destination: not yet copied at their
   * current etag, and not permanently failed (exhausted retries). */
  listObjectsNeedingWork(bucketId: string, backupAccountId: string, limit: number): ObjectRow[] {
    return this.db
      .query<ObjectRow, [string, string, string, number]>(
        `SELECT o.* FROM objects o
          WHERE o.bucket_id = ? AND o.status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM backup_object_status s
               WHERE s.backup_account_id = ? AND s.object_id = o.id
                 AND s.object_etag = o.etag AND s.status = 'copied'
            )
            AND NOT EXISTS (
              SELECT 1 FROM backup_object_status s
               WHERE s.backup_account_id = ? AND s.object_id = o.id
                 AND s.object_etag = o.etag AND s.status = 'failed' AND s.attempts >= ${MAX_BACKUP_ITEM_ATTEMPTS}
            )
          ORDER BY o.created_at ASC LIMIT ?`,
      )
      .all(bucketId, backupAccountId, backupAccountId, limit);
  }

  markObjectCopied(input: {
    transferId: string;
    backupAccountId: string;
    objectId: string;
    objectKey: string;
    objectEtag: string;
    destinationFileId: string;
  }): void {
    const now = nowIso();
    const tx = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO backup_object_status
             (backup_account_id, object_id, object_key, object_etag, status,
              destination_file_id, attempts, last_error, last_transfer_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'copied', ?, 1, NULL, ?, ?, ?)
           ON CONFLICT(backup_account_id, object_id) DO UPDATE SET
             object_key = excluded.object_key,
             object_etag = excluded.object_etag,
             status = 'copied',
             destination_file_id = excluded.destination_file_id,
             attempts = backup_object_status.attempts + 1,
             last_error = NULL,
             last_transfer_id = excluded.last_transfer_id,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.backupAccountId,
          input.objectId,
          input.objectKey,
          input.objectEtag,
          input.destinationFileId,
          input.transferId,
          now,
          now,
        );
      this.db
        .query("UPDATE backup_transfers SET copied_count = copied_count + 1, updated_at = ? WHERE id = ?")
        .run(now, input.transferId);
    });
    tx();
  }

  markObjectFailed(input: {
    transferId: string;
    backupAccountId: string;
    objectId: string;
    objectKey: string;
    objectEtag: string;
    error: string;
  }): void {
    const now = nowIso();
    const tx = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO backup_object_status
             (backup_account_id, object_id, object_key, object_etag, status,
              destination_file_id, attempts, last_error, last_transfer_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'failed', NULL, 1, ?, ?, ?, ?)
           ON CONFLICT(backup_account_id, object_id) DO UPDATE SET
             object_key = excluded.object_key,
             object_etag = excluded.object_etag,
             status = 'failed',
             attempts = backup_object_status.attempts + 1,
             last_error = excluded.last_error,
             last_transfer_id = excluded.last_transfer_id,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.backupAccountId,
          input.objectId,
          input.objectKey,
          input.objectEtag,
          input.error.slice(0, 500),
          input.transferId,
          now,
          now,
        );
      this.db
        .query(
          `UPDATE backup_transfers SET failed_count = failed_count + 1, last_error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(input.error.slice(0, 500), now, input.transferId);
    });
    tx();
  }

  /** Marks the transfer terminal once no work remains (or cancellation was requested). */
  refreshAndMaybeFinish(id: string): BackupTransferRow {
    const tx = this.db.transaction(() => {
      const job = this.db.query<BackupTransferRow, [string]>("SELECT * FROM backup_transfers WHERE id = ?").get(id);
      if (!job) return;
      const cancelled = job.status === "cancel_requested";
      const remaining = job.total_count - job.skipped_count - job.copied_count - job.failed_count;
      const terminal = cancelled || remaining <= 0;
      if (!terminal) return;
      const now = nowIso();
      this.db
        .query(
          `UPDATE backup_transfers SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(cancelled ? "cancelled" : "completed", now, now, id);
    });
    tx();
    return this.findById(id)!;
  }

  failJob(id: string, error: string): void {
    const now = nowIso();
    this.db
      .query(
        `UPDATE backup_transfers
            SET status = 'failed', last_error = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND status NOT IN ('completed', 'cancelled')`,
      )
      .run(error.slice(0, 500), now, now, id);
  }

  requestCancel(userId: string, bucketId: string, id: string): boolean {
    return (
      this.db
        .query(
          `UPDATE backup_transfers SET status = 'cancel_requested', updated_at = ?
            WHERE id = ? AND user_id = ? AND bucket_id = ? AND status IN ('queued', 'running')`,
        )
        .run(nowIso(), id, userId, bucketId).changes > 0
    );
  }
}
