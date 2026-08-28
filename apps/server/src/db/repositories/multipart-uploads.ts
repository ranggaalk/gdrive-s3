// Multipart uploads repository. Namespace scoping is enforced by joining
// through the owning bucket; abort/complete state transitions are guarded.

import type { Database } from "bun:sqlite";
import { nowIso } from "../../util/ids.ts";

export type MultipartStatus =
  | "open"
  | "completing"
  | "completed"
  | "aborted"
  | "expired";

export interface MultipartUploadRow {
  id: string;
  bucket_id: string;
  object_key: string;
  user_id: string;
  content_type: string;
  metadata_json: string;
  status: MultipartStatus;
  initiated_at: string;
  expires_at: string;
  completed_at: string | null;
  drive_folder_id: string | null;
  total_parts: number | null;
  last_error: string | null;
  drive_target_id: string | null;
  sse_algorithm: string | null;
  sse_kms_key_id: string | null;
  sse_kms_key_version: number | null;
  sse_wrapped_data_key: string | null;
  sse_iv: string | null;
  sse_customer_key_md5: string | null;
}

export interface CreateMultipartInput {
  id: string;
  userId: string;
  bucketId: string;
  driveFolderId: string;
  objectKey: string;
  contentType: string;
  metadata: Record<string, string>;
  expiresAt: string;
  driveTargetId?: string;
  /** Chosen once at CreateMultipartUpload so every part and the final
   *  assembly share one data key. */
  sse?: {
    algorithm: string;
    kmsKeyId: string | null;
    kmsKeyVersion: number | null;
    wrappedDataKey: string | null;
    iv: string;
    customerKeyMd5: string | null;
  } | null;
}

export class MultipartUploadsRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateMultipartInput): MultipartUploadRow {
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO multipart_uploads
           (id, bucket_id, object_key, user_id, content_type, metadata_json,
            status, initiated_at, expires_at, drive_folder_id, drive_target_id,
            sse_algorithm, sse_kms_key_id, sse_kms_key_version,
            sse_wrapped_data_key, sse_iv, sse_customer_key_md5)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.bucketId,
        input.objectKey,
        input.userId,
        input.contentType,
        JSON.stringify(input.metadata),
        now,
        input.expiresAt,
        input.driveFolderId,
        input.driveTargetId ?? null,
        input.sse?.algorithm ?? null,
        input.sse?.kmsKeyId ?? null,
        input.sse?.kmsKeyVersion ?? null,
        input.sse?.wrappedDataKey ?? null,
        input.sse?.iv ?? null,
        input.sse?.customerKeyMd5 ?? null,
      );
    return this.byId(input.id)!;
  }

  byId(id: string): MultipartUploadRow | null {
    return (
      this.db
        .query<MultipartUploadRow, [string]>("SELECT * FROM multipart_uploads WHERE id = ?")
        .get(id) ?? null
    );
  }

  findOwned(userId: string, id: string): MultipartUploadRow | null {
    return (
      this.db
        .query<MultipartUploadRow, [string, string]>(
          "SELECT * FROM multipart_uploads WHERE id = ? AND user_id = ?",
        )
        .get(id, userId) ?? null
    );
  }

  listOpenByBucket(bucketId: string, limit = 1000): MultipartUploadRow[] {
    return this.db
      .query<MultipartUploadRow, [string, number]>(
        `SELECT * FROM multipart_uploads
          WHERE bucket_id = ? AND status = 'open'
          ORDER BY initiated_at ASC
          LIMIT ?`,
      )
      .all(bucketId, limit);
  }

  countOpenForUser(userId: string): number {
    const row = this.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM multipart_uploads WHERE user_id = ? AND status = 'open'",
      )
      .get(userId);
    return row?.n ?? 0;
  }

  countOpenByBucket(bucketId: string): number {
    const row = this.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM multipart_uploads WHERE bucket_id = ? AND status = 'open'",
      )
      .get(bucketId);
    return row?.n ?? 0;
  }

  hasOpenInBucket(bucketId: string): boolean {
    const row = this.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM multipart_uploads WHERE bucket_id = ? AND status = 'open'",
      )
      .get(bucketId);
    return (row?.n ?? 0) > 0;
  }

  listExpired(nowIsoStr: string, limit: number): MultipartUploadRow[] {
    return this.db
      .query<MultipartUploadRow, [string, number]>(
        `SELECT * FROM multipart_uploads
          WHERE status = 'open' AND expires_at <= ?
          ORDER BY expires_at ASC
          LIMIT ?`,
      )
      .all(nowIsoStr, limit);
  }

  markCompleting(id: string): boolean {
    const changes = this.db
      .query(
        `UPDATE multipart_uploads
            SET status = 'completing', last_error = NULL
          WHERE id = ? AND status = 'open'`,
      )
      .run(id).changes;
    return changes > 0;
  }

  markCompleted(id: string, totalParts: number): void {
    const now = nowIso();
    this.db
      .query(
        `UPDATE multipart_uploads
            SET status = 'completed', completed_at = ?, total_parts = ?
          WHERE id = ?`,
      )
      .run(now, totalParts, id);
  }

  markFailed(id: string, error: string): void {
    this.db
      .query(
        `UPDATE multipart_uploads
            SET status = 'aborted', last_error = ?
          WHERE id = ? AND status IN ('open', 'completing')`,
      )
      .run(error, id);
  }

  markAborted(id: string): boolean {
    const changes = this.db
      .query(
        `UPDATE multipart_uploads
            SET status = 'aborted'
          WHERE id = ? AND status IN ('open', 'completing')`,
      )
      .run(id).changes;
    return changes > 0;
  }

  markExpired(id: string): boolean {
    const changes = this.db
      .query(
        `UPDATE multipart_uploads
            SET status = 'expired'
          WHERE id = ? AND status = 'open'`,
      )
      .run(id).changes;
    return changes > 0;
  }
}
