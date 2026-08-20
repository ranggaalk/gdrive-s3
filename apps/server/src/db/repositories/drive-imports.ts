import type { Database } from "bun:sqlite";
import {
  newDriveImportFolderId,
  newDriveImportItemId,
  newDriveImportJobId,
  nowIso,
} from "../../util/ids.ts";

export type DriveImportSourceKind = "my_drive" | "shared_drive";
export type DriveImportJobStatus =
  | "queued"
  | "running"
  | "cancel_requested"
  | "completed"
  | "cancelled"
  | "failed";
export type DriveImportItemStatus =
  | "pending"
  | "importing"
  | "imported"
  | "conflict"
  | "unsupported"
  | "failed";

export interface DriveImportJobRow {
  id: string;
  user_id: string;
  bucket_id: string;
  source_kind: DriveImportSourceKind;
  source_drive_id: string | null;
  source_folder_id: string;
  source_folder_name: string;
  phase: "scan" | "copy";
  status: DriveImportJobStatus;
  discovered_count: number;
  imported_count: number;
  conflict_count: number;
  unsupported_count: number;
  failed_count: number;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface DriveImportFolderRow {
  id: string;
  job_id: string;
  source_folder_id: string;
  relative_path: string;
  next_page_token: string | null;
  status: "pending" | "scanning" | "completed";
  created_at: string;
  updated_at: string;
}

export interface DriveImportItemRow {
  id: string;
  job_id: string;
  source_file_id: string;
  source_name: string;
  source_mime_type: string;
  source_size_bytes: number | null;
  source_md5_checksum: string | null;
  source_modified_time: string | null;
  source_version: string | null;
  object_key: string;
  status: DriveImportItemStatus;
  reason: string | null;
  destination_object_id: string | null;
  staging_request_id: string;
  attempts: number;
  created_at: string;
  updated_at: string;
}

export interface DiscoveredImportItem {
  sourceFileId: string;
  sourceName: string;
  mimeType: string;
  sizeBytes: number | null;
  md5Checksum: string | null;
  modifiedTime: string | null;
  version: string | null;
  objectKey: string;
  status: "pending" | "unsupported";
  reason?: string;
}

export class DriveImportsRepository {
  constructor(private readonly db: Database) {}

  create(input: {
    userId: string;
    bucketId: string;
    sourceKind: DriveImportSourceKind;
    sourceDriveId?: string;
    sourceFolderId: string;
    sourceFolderName: string;
  }): DriveImportJobRow {
    const existing = this.db
      .query<DriveImportJobRow, [string, string, string, string]>(
        `SELECT * FROM drive_import_jobs
          WHERE bucket_id = ? AND source_kind = ?
            AND COALESCE(source_drive_id, '') = ? AND source_folder_id = ?`,
      )
      .get(input.bucketId, input.sourceKind, input.sourceDriveId ?? "", input.sourceFolderId);
    if (existing) return existing;

    const id = newDriveImportJobId();
    const now = nowIso();
    const tx = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO drive_import_jobs
             (id, user_id, bucket_id, source_kind, source_drive_id,
              source_folder_id, source_folder_name, phase, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'scan', 'queued', ?, ?)`,
        )
        .run(
          id,
          input.userId,
          input.bucketId,
          input.sourceKind,
          input.sourceDriveId ?? null,
          input.sourceFolderId,
          input.sourceFolderName,
          now,
          now,
        );
      this.db
        .query(
          `INSERT INTO drive_import_folders
             (id, job_id, source_folder_id, relative_path, status, created_at, updated_at)
           VALUES (?, ?, ?, '', 'pending', ?, ?)`,
        )
        .run(newDriveImportFolderId(), id, input.sourceFolderId, now, now);
    });
    tx();
    return this.findOwned(input.userId, input.bucketId, id)!;
  }

  findOwned(userId: string, bucketId: string, jobId: string): DriveImportJobRow | null {
    return this.db
      .query<DriveImportJobRow, [string, string, string]>(
        "SELECT * FROM drive_import_jobs WHERE id = ? AND bucket_id = ? AND user_id = ?",
      )
      .get(jobId, bucketId, userId) ?? null;
  }

  listOwned(userId: string, bucketId: string, limit = 20): DriveImportJobRow[] {
    return this.db
      .query<DriveImportJobRow, [string, string, number]>(
        `SELECT * FROM drive_import_jobs
          WHERE user_id = ? AND bucket_id = ?
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(userId, bucketId, limit);
  }

  claimNextJob(): DriveImportJobRow | null {
    let claimed: DriveImportJobRow | null = null;
    const tx = this.db.transaction(() => {
      const row = this.db
        .query<DriveImportJobRow, []>(
          `SELECT * FROM drive_import_jobs
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
            `UPDATE drive_import_jobs
                SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
              WHERE id = ? AND status = 'queued'`,
          )
          .run(now, now, row.id);
      }
      claimed = this.db
        .query<DriveImportJobRow, [string]>("SELECT * FROM drive_import_jobs WHERE id = ?")
        .get(row.id) ?? null;
    });
    tx();
    return claimed;
  }

  nextFolder(jobId: string): DriveImportFolderRow | null {
    let result: DriveImportFolderRow | null = null;
    const tx = this.db.transaction(() => {
      const folder = this.db
        .query<DriveImportFolderRow, [string]>(
          `SELECT * FROM drive_import_folders
            WHERE job_id = ? AND status IN ('scanning', 'pending')
            ORDER BY CASE status WHEN 'scanning' THEN 0 ELSE 1 END, created_at ASC
            LIMIT 1`,
        )
        .get(jobId);
      if (!folder) return;
      if (folder.status === "pending") {
        this.db
          .query("UPDATE drive_import_folders SET status = 'scanning', updated_at = ? WHERE id = ?")
          .run(nowIso(), folder.id);
      }
      result = this.db
        .query<DriveImportFolderRow, [string]>(
          "SELECT * FROM drive_import_folders WHERE id = ?",
        )
        .get(folder.id) ?? null;
    });
    tx();
    return result;
  }

  saveFolderPage(input: {
    jobId: string;
    folderId: string;
    folders: Array<{ sourceFolderId: string; relativePath: string }>;
    items: DiscoveredImportItem[];
    nextPageToken: string | null;
  }): void {
    const tx = this.db.transaction(() => {
      const now = nowIso();
      let discovered = 0;
      for (const folder of input.folders) {
        this.db
          .query(
            `INSERT OR IGNORE INTO drive_import_folders
               (id, job_id, source_folder_id, relative_path, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
          )
          .run(
            newDriveImportFolderId(),
            input.jobId,
            folder.sourceFolderId,
            folder.relativePath,
            now,
            now,
          );
      }
      for (const item of input.items) {
        const inserted = this.db
          .query(
            `INSERT OR IGNORE INTO drive_import_items
               (id, job_id, source_file_id, source_name, source_mime_type,
                source_size_bytes, source_md5_checksum, source_modified_time,
                source_version, object_key, key_bytes, status, reason, staging_request_id,
                created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            newDriveImportItemId(),
            input.jobId,
            item.sourceFileId,
            item.sourceName,
            item.mimeType,
            item.sizeBytes,
            item.md5Checksum,
            item.modifiedTime,
            item.version,
            item.objectKey,
            Buffer.byteLength(item.objectKey, "utf8"),
            item.status,
            item.reason ?? null,
            `drive-import:${input.jobId}:${item.sourceFileId}`,
            now,
            now,
          ).changes;
        discovered += inserted;
      }
      this.db
        .query(
          `UPDATE drive_import_folders
              SET next_page_token = ?, status = ?, updated_at = ?
            WHERE id = ? AND job_id = ?`,
        )
        .run(
          input.nextPageToken,
          input.nextPageToken ? "scanning" : "completed",
          now,
          input.folderId,
          input.jobId,
        );
      this.db
        .query(
          `UPDATE drive_import_jobs
              SET discovered_count = discovered_count + ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(discovered, now, input.jobId);
    });
    tx();
  }

  finalizeScan(jobId: string): void {
    const tx = this.db.transaction(() => {
      const remaining = this.db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM drive_import_folders WHERE job_id = ? AND status != 'completed'",
        )
        .get(jobId)?.count ?? 0;
      if (remaining > 0) return;
      const now = nowIso();
      this.db
        .query(
          `UPDATE drive_import_items
              SET status = 'conflict', reason = 'duplicate_source_key', updated_at = ?
            WHERE job_id = ? AND status = 'pending' AND object_key IN (
              SELECT object_key FROM drive_import_items
               WHERE job_id = ? GROUP BY object_key HAVING COUNT(*) > 1
            )`,
        )
        .run(now, jobId, jobId);
      this.db
        .query(
          `UPDATE drive_import_items
              SET status = 'conflict', reason = 'destination_key_exists', updated_at = ?
            WHERE job_id = ? AND status = 'pending' AND EXISTS (
              SELECT 1 FROM drive_import_jobs j
              JOIN objects o ON o.bucket_id = j.bucket_id
              WHERE j.id = drive_import_items.job_id
                AND o.object_key = drive_import_items.object_key
            )`,
        )
        .run(now, jobId);
      this.db
        .query(
          `UPDATE drive_import_jobs SET phase = 'copy',
              conflict_count = (SELECT COUNT(*) FROM drive_import_items WHERE job_id = ? AND status = 'conflict'),
              unsupported_count = (SELECT COUNT(*) FROM drive_import_items WHERE job_id = ? AND status = 'unsupported'),
              updated_at = ? WHERE id = ?`,
        )
        .run(jobId, jobId, now, jobId);
    });
    tx();
  }

  claimItems(jobId: string, limit: number): DriveImportItemRow[] {
    const interrupted = this.db
      .query<DriveImportItemRow, [string, number]>(
        `SELECT * FROM drive_import_items
          WHERE job_id = ? AND status = 'importing' ORDER BY created_at ASC LIMIT ?`,
      )
      .all(jobId, limit);
    if (interrupted.length > 0) return interrupted;
    const ids = this.db
      .query<{ id: string }, [string, number]>(
        `SELECT id FROM drive_import_items
          WHERE job_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT ?`,
      )
      .all(jobId, limit)
      .map((row) => row.id);
    if (ids.length === 0) return [];
    const tx = this.db.transaction(() => {
      const now = nowIso();
      for (const id of ids) {
        this.db
          .query(
            `UPDATE drive_import_items
                SET status = 'importing', attempts = attempts + 1, updated_at = ?
              WHERE id = ? AND status = 'pending'`,
          )
          .run(now, id);
      }
    });
    tx();
    return ids.flatMap((id) => {
      const row = this.db
        .query<DriveImportItemRow, [string]>("SELECT * FROM drive_import_items WHERE id = ?")
        .get(id);
      return row?.status === "importing" ? [row] : [];
    });
  }

  markItem(
    itemId: string,
    status: "imported" | "conflict" | "unsupported" | "failed",
    reason: string | null,
    destinationObjectId?: string,
  ): void {
    this.db
      .query(
        `UPDATE drive_import_items
            SET status = ?, reason = ?, destination_object_id = ?, updated_at = ?
          WHERE id = ? AND status = 'importing'`,
      )
      .run(status, reason, destinationObjectId ?? null, nowIso(), itemId);
  }

  refreshAndMaybeFinish(jobId: string): DriveImportJobRow {
    const tx = this.db.transaction(() => {
      const now = nowIso();
      const counts = this.db
        .query<{
          imported: number;
          conflicts: number;
          unsupported: number;
          failed: number;
          outstanding: number;
        }, [string]>(
          `SELECT
             SUM(CASE WHEN status = 'imported' THEN 1 ELSE 0 END) AS imported,
             SUM(CASE WHEN status = 'conflict' THEN 1 ELSE 0 END) AS conflicts,
             SUM(CASE WHEN status = 'unsupported' THEN 1 ELSE 0 END) AS unsupported,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN status IN ('pending', 'importing') THEN 1 ELSE 0 END) AS outstanding
           FROM drive_import_items WHERE job_id = ?`,
        )
        .get(jobId) ?? { imported: 0, conflicts: 0, unsupported: 0, failed: 0, outstanding: 0 };
      const job = this.db
        .query<DriveImportJobRow, [string]>("SELECT * FROM drive_import_jobs WHERE id = ?")
        .get(jobId);
      const cancelled = job?.status === "cancel_requested";
      const terminal = cancelled || (job?.phase === "copy" && Number(counts.outstanding ?? 0) === 0);
      this.db
        .query(
          `UPDATE drive_import_jobs SET
             imported_count = ?, conflict_count = ?, unsupported_count = ?, failed_count = ?,
             status = CASE WHEN ? THEN ? ELSE status END,
             completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
             updated_at = ? WHERE id = ?`,
        )
        .run(
          Number(counts.imported ?? 0),
          Number(counts.conflicts ?? 0),
          Number(counts.unsupported ?? 0),
          Number(counts.failed ?? 0),
          terminal ? 1 : 0,
          cancelled ? "cancelled" : "completed",
          terminal ? 1 : 0,
          now,
          now,
          jobId,
        );
    });
    tx();
    return this.db
      .query<DriveImportJobRow, [string]>("SELECT * FROM drive_import_jobs WHERE id = ?")
      .get(jobId)!;
  }

  failJob(jobId: string, error: string): void {
    const now = nowIso();
    this.db
      .query(
        `UPDATE drive_import_jobs
            SET status = 'failed', last_error = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND status NOT IN ('completed', 'cancelled')`,
      )
      .run(error, now, now, jobId);
  }

  requestCancel(userId: string, bucketId: string, jobId: string): boolean {
    return this.db
      .query(
        `UPDATE drive_import_jobs SET status = 'cancel_requested', updated_at = ?
          WHERE id = ? AND user_id = ? AND bucket_id = ? AND status IN ('queued', 'running')`,
      )
      .run(nowIso(), jobId, userId, bucketId).changes > 0;
  }

  listItems(
    userId: string,
    bucketId: string,
    jobId: string,
    opts: { afterId?: string; limit: number },
  ): { items: DriveImportItemRow[]; hasMore: boolean } {
    const items = this.db
      .query<DriveImportItemRow, [string, string, string, string, number]>(
        `SELECT i.* FROM drive_import_items i
          JOIN drive_import_jobs j ON j.id = i.job_id
          WHERE j.user_id = ? AND j.bucket_id = ? AND j.id = ?
            AND i.status IN ('conflict', 'unsupported', 'failed') AND i.id > ?
          ORDER BY i.id ASC LIMIT ?`,
      )
      .all(userId, bucketId, jobId, opts.afterId ?? "", opts.limit + 1);
    return { items: items.slice(0, opts.limit), hasMore: items.length > opts.limit };
  }
}
