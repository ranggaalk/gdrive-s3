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

/** A transfer row joined with the names history views need. The bucket and
 *  the destination account both cascade-delete into `backup_transfers`, so an
 *  inner join can never drop a surviving run. */
export interface BackupTransferHistoryRow extends BackupTransferRow {
  bucket_name: string;
  account_email: string;
}

export type BackupObjectStatus = "copied" | "failed";

/** One line of the per-object ledger, as written by the run that produced it. */
export interface BackupObjectStatusRow {
  backup_account_id: string;
  object_id: string;
  object_key: string;
  object_etag: string;
  status: BackupObjectStatus;
  destination_file_id: string | null;
  attempts: number;
  last_error: string | null;
  last_transfer_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Per-destination rollup for the account cards. */
export interface BackupAccountSummaryRow {
  backup_account_id: string;
  runs: number;
  last_run_at: string | null;
  last_status: BackupTransferStatus | null;
  copied_total: number;
  failed_total: number;
  skipped_total: number;
  active_runs: number;
  objects_on_record: number;
}

export interface BackupHistoryFilter {
  backupAccountId?: string;
  bucketId?: string;
  status?: BackupTransferStatus;
}

/**
 * History pages are keyed on (timestamp, id) rather than the timestamp alone.
 * Two runs started in the same millisecond are entirely possible -- one per
 * bucket against the same destination -- and a timestamp-only cursor would
 * either repeat them or skip them.
 */
export interface HistoryCursor {
  at: string;
  id: string;
}

export function encodeHistoryCursor(cursor: HistoryCursor): string {
  return `${cursor.at}|${cursor.id}`;
}

export function parseHistoryCursor(raw: string | null | undefined): HistoryCursor | null {
  if (!raw) return null;
  const separator = raw.indexOf("|");
  if (separator <= 0 || separator === raw.length - 1) return null;
  return { at: raw.slice(0, separator), id: raw.slice(separator + 1) };
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

  /** Newest-first history across every bucket the user owns, optionally
   *  narrowed to one destination account, one bucket, or one status. */
  listForUser(
    userId: string,
    options: { limit: number; before?: HistoryCursor | null } & BackupHistoryFilter,
  ): BackupTransferHistoryRow[] {
    const where = ["t.user_id = ?"];
    const params: (string | number)[] = [userId];
    if (options.backupAccountId) {
      where.push("t.backup_account_id = ?");
      params.push(options.backupAccountId);
    }
    if (options.bucketId) {
      where.push("t.bucket_id = ?");
      params.push(options.bucketId);
    }
    if (options.status) {
      where.push("t.status = ?");
      params.push(options.status);
    }
    if (options.before) {
      where.push("(t.created_at < ? OR (t.created_at = ? AND t.id < ?))");
      params.push(options.before.at, options.before.at, options.before.id);
    }
    params.push(options.limit);
    return this.db
      .query<BackupTransferHistoryRow, (string | number)[]>(
        `SELECT t.*, b.name AS bucket_name, a.email AS account_email
           FROM backup_transfers t
           JOIN buckets b ON b.id = t.bucket_id
           JOIN backup_accounts a ON a.id = t.backup_account_id
          WHERE ${where.join(" AND ")}
          ORDER BY t.created_at DESC, t.id DESC
          LIMIT ?`,
      )
      .all(...params);
  }

  /** A single run by id, not scoped to a bucket -- the history views reach a
   *  run from the account side, where the bucket is what they want told. */
  findOwnedHistory(userId: string, id: string): BackupTransferHistoryRow | null {
    return (
      this.db
        .query<BackupTransferHistoryRow, [string, string]>(
          `SELECT t.*, b.name AS bucket_name, a.email AS account_email
             FROM backup_transfers t
             JOIN buckets b ON b.id = t.bucket_id
             JOIN backup_accounts a ON a.id = t.backup_account_id
            WHERE t.id = ? AND t.user_id = ?`,
        )
        .get(id, userId) ?? null
    );
  }

  /**
   * The per-object ledger lines this run wrote. The ledger keeps one row per
   * (destination, object) and stamps it with `last_transfer_id`, so a later run
   * that re-copies the same object takes the line over -- an older run then
   * reports fewer lines than its counters. That is the ledger telling the
   * truth about what is currently attributable to the run, so the API reports
   * both numbers rather than pretending they always agree.
   */
  listTransferObjects(
    transferId: string,
    options: { limit: number; before?: HistoryCursor | null; status?: BackupObjectStatus },
  ): BackupObjectStatusRow[] {
    const where = ["last_transfer_id = ?"];
    const params: (string | number)[] = [transferId];
    if (options.status) {
      where.push("status = ?");
      params.push(options.status);
    }
    if (options.before) {
      where.push("(updated_at < ? OR (updated_at = ? AND object_id < ?))");
      params.push(options.before.at, options.before.at, options.before.id);
    }
    params.push(options.limit);
    return this.db
      .query<BackupObjectStatusRow, (string | number)[]>(
        `SELECT * FROM backup_object_status
          WHERE ${where.join(" AND ")}
          ORDER BY updated_at DESC, object_id DESC
          LIMIT ?`,
      )
      .all(...params);
  }

  /** How many ledger lines this run currently owns, per status. */
  countTransferObjects(transferId: string): { copied: number; failed: number } {
    const rows = this.db
      .query<{ status: BackupObjectStatus; n: number }, [string]>(
        `SELECT status, COUNT(*) AS n FROM backup_object_status
          WHERE last_transfer_id = ? GROUP BY status`,
      )
      .all(transferId);
    return {
      copied: rows.find((r) => r.status === "copied")?.n ?? 0,
      failed: rows.find((r) => r.status === "failed")?.n ?? 0,
    };
  }

  /** Rollup per destination account, for the account cards and the totals
   *  strip above the history table. */
  summarizeByAccount(userId: string): BackupAccountSummaryRow[] {
    return this.db
      .query<BackupAccountSummaryRow, [string, string]>(
        `SELECT a.id AS backup_account_id,
                COUNT(t.id) AS runs,
                MAX(t.created_at) AS last_run_at,
                (SELECT l.status FROM backup_transfers l
                  WHERE l.backup_account_id = a.id AND l.user_id = ?
                  ORDER BY l.created_at DESC, l.id DESC LIMIT 1) AS last_status,
                COALESCE(SUM(t.copied_count), 0) AS copied_total,
                COALESCE(SUM(t.failed_count), 0) AS failed_total,
                COALESCE(SUM(t.skipped_count), 0) AS skipped_total,
                COALESCE(SUM(CASE WHEN t.status IN ('queued', 'running', 'cancel_requested')
                                  THEN 1 ELSE 0 END), 0) AS active_runs,
                (SELECT COUNT(*) FROM backup_object_status s
                  WHERE s.backup_account_id = a.id AND s.status = 'copied') AS objects_on_record
           FROM backup_accounts a
           LEFT JOIN backup_transfers t
             ON t.backup_account_id = a.id AND t.user_id = a.owner_user_id
          WHERE a.owner_user_id = ?
          GROUP BY a.id
          ORDER BY a.created_at ASC`,
      )
      .all(userId, userId);
  }
}
