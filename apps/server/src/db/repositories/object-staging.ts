// Durable staging record for object writes (AGENTS.md §8, §22).
// A staging row is created before we touch Google Drive so a crash between
// steps can be recovered without losing bytes or duplicating active mappings.

import type { Database } from "bun:sqlite";
import { newObjectId, nowIso } from "../../util/ids.ts";

export type StagingStatus = "uploading" | "uploaded" | "committed" | "failed";

export interface StagingRow {
  id: string;
  request_id: string;
  user_id: string;
  bucket_id: string;
  object_key: string;
  object_id: string;
  new_drive_file_id: string | null;
  old_drive_file_id: string | null;
  size_bytes: number | null;
  etag: string | null;
  checksum_sha256: string | null;
  content_type: string | null;
  metadata_json: string;
  cache_control: string | null;
  content_disposition: string | null;
  content_encoding: string | null;
  content_language: string | null;
  expires_at: string | null;
  status: StagingStatus;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  drive_target_id: string | null;
}

export interface StartStagingInput {
  requestId: string;
  userId: string;
  bucketId: string;
  objectKey: string;
  contentType: string;
  metadata: Record<string, string>;
  cacheControl: string | null;
  contentDisposition: string | null;
  contentEncoding: string | null;
  contentLanguage: string | null;
  expiresAt: string | null;
  oldDriveFileId: string | null;
  driveTargetId?: string;
}

export interface MarkUploadedInput {
  id: string;
  driveFileId: string;
  sizeBytes: number;
  etag: string;
  checksumSha256: string;
}

export class ObjectStagingRepository {
  constructor(private readonly db: Database) {}

  start(input: StartStagingInput): StagingRow {
    const id = `stg_${crypto.randomUUID().replace(/-/g, "")}`;
    const objectId = newObjectId();
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO object_staging
           (id, request_id, user_id, bucket_id, object_key, object_id,
            old_drive_file_id, content_type, metadata_json, cache_control,
            content_disposition, content_encoding, content_language, expires_at,
            drive_target_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)`,
      )
      .run(
        id,
        input.requestId,
        input.userId,
        input.bucketId,
        input.objectKey,
        objectId,
        input.oldDriveFileId,
        input.contentType,
        JSON.stringify(input.metadata),
        input.cacheControl,
        input.contentDisposition,
        input.contentEncoding,
        input.contentLanguage,
        input.expiresAt,
        input.driveTargetId ?? null,
        now,
        now,
      );
    return this.byId(id)!;
  }

  byId(id: string): StagingRow | null {
    return (
      this.db
        .query<StagingRow, [string]>("SELECT * FROM object_staging WHERE id = ?")
        .get(id) ?? null
    );
  }

  byRequestId(requestId: string): StagingRow | null {
    return (
      this.db
        .query<StagingRow, [string]>("SELECT * FROM object_staging WHERE request_id = ?")
        .get(requestId) ?? null
    );
  }

  markUploaded(input: MarkUploadedInput): void {
    this.db
      .query(
        `UPDATE object_staging
            SET status = 'uploaded',
                new_drive_file_id = ?,
                size_bytes = ?,
                etag = ?,
                checksum_sha256 = ?,
                updated_at = ?
          WHERE id = ? AND status = 'uploading'`,
      )
      .run(
        input.driveFileId,
        input.sizeBytes,
        input.etag,
        input.checksumSha256,
        nowIso(),
        input.id,
      );
  }

  markFailed(id: string, error: string): void {
    this.db
      .query(
        `UPDATE object_staging
            SET status = 'failed', last_error = ?, updated_at = ?
          WHERE id = ? AND status IN ('uploading', 'uploaded')`,
      )
      .run(error, nowIso(), id);
  }

  markCommitted(id: string): void {
    this.db
      .query(
        `UPDATE object_staging
            SET status = 'committed', last_error = NULL, updated_at = ?
          WHERE id = ? AND status IN ('uploaded', 'uploading')`,
      )
      .run(nowIso(), id);
  }

  /** Rows whose status is not terminal and older than the given ISO cutoff. */
  listStale(cutoffIso: string, limit: number): StagingRow[] {
    return this.db
      .query<StagingRow, [string, number]>(
        `SELECT * FROM object_staging
          WHERE status IN ('uploading', 'uploaded')
            AND updated_at < ?
          ORDER BY updated_at ASC
          LIMIT ?`,
      )
      .all(cutoffIso, limit);
  }

  delete(id: string): void {
    this.db.query("DELETE FROM object_staging WHERE id = ?").run(id);
  }
}
