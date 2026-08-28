// Objects repository. Listing is always joined/scoped to the owning user's
// bucket. Byte upload/download lands in later milestones; this milestone only
// reads the namespace and supports counts/aggregates for the dashboard.

import type { Database } from "bun:sqlite";
import { newObjectId, nowIso } from "../../util/ids.ts";

export type ObjectAclName =
  | "private"
  | "public-read"
  | "public-read-write"
  | "authenticated-read"
  | "bucket-owner-read"
  | "bucket-owner-full-control";

export type ObjectStatus =
  | "active"
  | "missing"
  | "externally_modified"
  | "deleting"
  | "error";

export interface ObjectRow {
  id: string;
  bucket_id: string;
  object_key: string;
  drive_file_id: string;
  size_bytes: number;
  content_type: string;
  etag: string;
  checksum_sha256: string | null;
  storage_class: string;
  status: ObjectStatus;
  metadata_json: string;
  cache_control: string | null;
  content_disposition: string | null;
  content_encoding: string | null;
  content_language: string | null;
  expires_at: string | null;
  acl: ObjectAclName;
  /** 'null' for objects written while versioning was off, matching S3. */
  version_id: string;
  last_modified_at: string;
  created_at: string;
  updated_at: string;
}

export interface ListPage {
  items: ObjectRow[];
  hasMore: boolean;
}

export interface UpsertObjectInput {
  bucketId: string;
  objectKey: string;
  driveFileId: string;
  sizeBytes: number;
  contentType: string;
  etag: string;
  checksumSha256?: string | null;
  metadata?: Record<string, string>;
  cacheControl?: string | null;
  contentDisposition?: string | null;
  contentEncoding?: string | null;
  contentLanguage?: string | null;
  expiresAt?: string | null;
  acl?: ObjectAclName;
  versionId?: string;
}

export class ObjectKeyConflictError extends Error {}

export interface ListObjectsResult {
  keys: ObjectRow[];
  commonPrefixes: string[];
  isTruncated: boolean;
  nextAfterKey: string | null;
  nextMarker: string | null;
}

export class ObjectsRepository {
  constructor(private readonly db: Database) {}

  findByIdOwned(userId: string, objectId: string): ObjectRow | null {
    return (
      this.db
        .query<ObjectRow, [string, string]>(
          `SELECT o.* FROM objects o
             JOIN buckets b ON b.id = o.bucket_id
            WHERE o.id = ? AND b.user_id = ?`,
        )
        .get(objectId, userId) ?? null
    );
  }

  findByKey(bucketId: string, objectKey: string): ObjectRow | null {
    return (
      this.db
        .query<ObjectRow, [string, string]>(
          "SELECT * FROM objects WHERE bucket_id = ? AND object_key = ? AND status = 'active'",
        )
        .get(bucketId, objectKey) ?? null
    );
  }

  findAnyByKey(bucketId: string, objectKey: string): ObjectRow | null {
    return (
      this.db
        .query<ObjectRow, [string, string]>(
          "SELECT * FROM objects WHERE bucket_id = ? AND object_key = ?",
        )
        .get(bucketId, objectKey) ?? null
    );
  }

  findActiveByIdInBucket(bucketId: string, objectId: string): ObjectRow | null {
    return (
      this.db
        .query<ObjectRow, [string, string]>(
          "SELECT * FROM objects WHERE bucket_id = ? AND id = ? AND status = 'active'",
        )
        .get(bucketId, objectId) ?? null
    );
  }

  /** Insert or replace namespace metadata atomically. Returns old row if any. */
  upsert(input: UpsertObjectInput): { current: ObjectRow; previous: ObjectRow | null } {
    const previous = this.findByKey(input.bucketId, input.objectKey);
    const id = previous?.id ?? newObjectId();
    const now = nowIso();
    const tx = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO objects
             (id, bucket_id, object_key, drive_file_id, size_bytes, content_type,
              etag, checksum_sha256, storage_class, status, metadata_json,
              cache_control, content_disposition, content_encoding,
              content_language, expires_at, acl, version_id, last_modified_at,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STANDARD', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(bucket_id, object_key) DO UPDATE SET
             drive_file_id = excluded.drive_file_id,
             size_bytes = excluded.size_bytes,
             content_type = excluded.content_type,
             etag = excluded.etag,
             checksum_sha256 = excluded.checksum_sha256,
             status = 'active',
             metadata_json = excluded.metadata_json,
             cache_control = excluded.cache_control,
             content_disposition = excluded.content_disposition,
             content_encoding = excluded.content_encoding,
             content_language = excluded.content_language,
             expires_at = excluded.expires_at,
             acl = excluded.acl,
             version_id = excluded.version_id,
             last_modified_at = excluded.last_modified_at,
             updated_at = excluded.updated_at`,
        )
        .run(
          id,
          input.bucketId,
          input.objectKey,
          input.driveFileId,
          input.sizeBytes,
          input.contentType,
          input.etag,
          input.checksumSha256 ?? null,
          JSON.stringify(input.metadata ?? {}),
          input.cacheControl ?? null,
          input.contentDisposition ?? null,
          input.contentEncoding ?? null,
          input.contentLanguage ?? null,
          input.expiresAt ?? null,
          input.acl ?? "private",
          input.versionId ?? "null",
          now,
          previous?.created_at ?? now,
          now,
        );
    });
    tx();
    return { current: this.findByKey(input.bucketId, input.objectKey)!, previous };
  }

  deleteByKey(bucketId: string, objectKey: string): ObjectRow | null {
    const existing = this.findByKey(bucketId, objectKey);
    if (!existing) return null;
    this.db
      .query("DELETE FROM objects WHERE bucket_id = ? AND object_key = ?")
      .run(bucketId, objectKey);
    return existing;
  }

  /**
   * Delete the namespace row AND enqueue the Drive file for cleanup inside a
   * single transaction so a crash between the two cannot lose track of bytes.
   */
  deleteAndQueueCleanup(input: {
    userId: string;
    bucketId: string;
    objectKey: string;
    reason: string;
    driveTargetId?: string;
  }): ObjectRow | null {
    let removed: ObjectRow | null = null;
    const tx = this.db.transaction(() => {
      const owner = this.db
        .query<{ user_id: string }, [string]>(
          "SELECT user_id FROM buckets WHERE id = ?",
        )
        .get(input.bucketId);
      if (!owner || owner.user_id !== input.userId) {
        throw new Error("bucket cleanup owner mismatch");
      }
      const existing = this.findByKey(input.bucketId, input.objectKey);
      if (!existing) return;
      this.db
        .query("DELETE FROM objects WHERE bucket_id = ? AND object_key = ?")
        .run(input.bucketId, input.objectKey);
      const now = nowIso();
      this.db
        .query(
          `INSERT INTO pending_cleanup
             (id, user_id, resource_type, resource_id, reason,
              attempts, next_attempt_at, created_at, drive_target_id)
           VALUES (?, ?, 'drive_file', ?, ?, 0, ?, ?, ?)`,
        )
        .run(
          `cln_${crypto.randomUUID().replace(/-/g, "")}`,
          input.userId,
          existing.drive_file_id,
          input.reason,
          now,
          now,
          input.driveTargetId ?? null,
        );
      removed = existing;
    });
    tx();
    return removed;
  }

  /**
   * Atomically promote an uploaded staging row into the active object
   * namespace and mark the staging row committed. The old Drive file remains
   * untouched until after this transaction commits.
   */
  commitStagedObject(
    stagingId: string,
    options: {
      ifAbsent?: boolean;
      /** When "Enabled", the row being replaced is archived instead of
       *  overwritten, and its Drive file is left alone. */
      versioning?: "Disabled" | "Enabled" | "Suspended";
      /** Version id for the new current object. */
      versionId?: string;
    } = {},
  ): {
    current: ObjectRow;
    previous: ObjectRow | null;
    /** True when `previous` was retained as a version rather than replaced. */
    archivedPrevious: boolean;
  } {
    let result:
      | { current: ObjectRow; previous: ObjectRow | null; archivedPrevious: boolean }
      | null = null;
    const tx = this.db.transaction(() => {
      const staging = this.db
        .query<{
          id: string;
          bucket_id: string;
          object_key: string;
          object_id: string;
          user_id: string;
          new_drive_file_id: string | null;
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
          acl: string;
          sse_algorithm: string | null;
          sse_kms_key_id: string | null;
          sse_kms_key_version: number | null;
          sse_wrapped_data_key: string | null;
          sse_iv: string | null;
          sse_customer_key_md5: string | null;
          status: string;
          drive_target_id: string | null;
        }, [string]>("SELECT * FROM object_staging WHERE id = ?")
        .get(stagingId);
      if (
        !staging ||
        staging.status !== "uploaded" ||
        !staging.new_drive_file_id ||
        staging.size_bytes === null ||
        !staging.etag ||
        !staging.content_type
      ) {
        throw new Error("staging row is not ready to commit");
      }

      const previous = this.findAnyByKey(staging.bucket_id, staging.object_key);
      if (options.ifAbsent && previous) {
        throw new ObjectKeyConflictError("object key already exists");
      }
      const now = nowIso();
      const newVersionId = options.versionId ?? "null";
      // Whether the row being replaced must be retained.
      //
      // Enabled always retains. Suspended is the subtle one: it writes the
      // 'null' version id, but it must NOT destroy versions created while
      // versioning was on. So a previous row is retained unless it is itself a
      // 'null' version, which a suspended write legitimately replaces.
      const archivePrevious =
        !!previous &&
        (options.versioning === "Enabled" ||
          (options.versioning === "Suspended" && previous.version_id !== "null"));

      // With versioning on, the row being replaced becomes a retained version
      // rather than being overwritten. Its Drive file must survive, which is
      // why the cleanup enqueue below is skipped in that case.
      if (archivePrevious && previous) {
        const previousEncryption = this.db
          .query<{
            sse_algorithm: string;
            kms_key_id: string | null;
            kms_key_version: number | null;
            wrapped_data_key: string | null;
            iv: string;
            customer_key_md5: string | null;
          }, [string]>(
            `SELECT sse_algorithm, kms_key_id, kms_key_version,
                    wrapped_data_key, iv, customer_key_md5
               FROM object_encryption WHERE object_id = ?`,
          )
          .get(previous.id);
        this.db
          .query(
            `INSERT INTO object_versions
               (id, bucket_id, object_key, version_id, drive_file_id, size_bytes,
                content_type, etag, checksum_sha256, storage_class, metadata_json,
                cache_control, content_disposition, content_encoding, content_language,
                expires_at, acl, is_delete_marker, is_latest,
                sse_algorithm, sse_kms_key_id, sse_kms_key_version,
                sse_wrapped_data_key, sse_iv, sse_customer_key_md5,
                last_modified_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(bucket_id, object_key, version_id) DO NOTHING`,
          )
          .run(
            `ver_${crypto.randomUUID().replace(/-/g, "")}`,
            previous.bucket_id,
            previous.object_key,
            previous.version_id,
            previous.drive_file_id,
            previous.size_bytes,
            previous.content_type,
            previous.etag,
            previous.checksum_sha256,
            previous.storage_class,
            previous.metadata_json,
            previous.cache_control,
            previous.content_disposition,
            previous.content_encoding,
            previous.content_language,
            previous.expires_at,
            previous.acl,
            previousEncryption?.sse_algorithm ?? null,
            previousEncryption?.kms_key_id ?? null,
            previousEncryption?.kms_key_version ?? null,
            previousEncryption?.wrapped_data_key ?? null,
            previousEncryption?.iv ?? null,
            previousEncryption?.customer_key_md5 ?? null,
            previous.last_modified_at,
            now,
          );
      }
      this.db
        .query(
          `INSERT INTO objects
             (id, bucket_id, object_key, drive_file_id, size_bytes, content_type,
              etag, checksum_sha256, storage_class, status, metadata_json,
              cache_control, content_disposition, content_encoding,
              content_language, expires_at, acl, version_id, last_modified_at,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STANDARD', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(bucket_id, object_key) DO UPDATE SET
             drive_file_id = excluded.drive_file_id,
             size_bytes = excluded.size_bytes,
             content_type = excluded.content_type,
             etag = excluded.etag,
             checksum_sha256 = excluded.checksum_sha256,
             status = 'active',
             metadata_json = excluded.metadata_json,
             cache_control = excluded.cache_control,
             content_disposition = excluded.content_disposition,
             content_encoding = excluded.content_encoding,
             content_language = excluded.content_language,
             expires_at = excluded.expires_at,
             acl = excluded.acl,
             version_id = excluded.version_id,
             last_modified_at = excluded.last_modified_at,
             updated_at = excluded.updated_at`,
        )
        .run(
          previous?.id ?? staging.object_id,
          staging.bucket_id,
          staging.object_key,
          staging.new_drive_file_id,
          staging.size_bytes,
          staging.content_type,
          staging.etag,
          staging.checksum_sha256,
          staging.metadata_json,
          staging.cache_control,
          staging.content_disposition,
          staging.content_encoding,
          staging.content_language,
          staging.expires_at,
          staging.acl,
          newVersionId,
          now,
          previous?.created_at ?? now,
          now,
        );
      // Encryption metadata rides the same transaction, keyed by the object id
      // the upsert just settled on. Clearing it on a plaintext overwrite
      // matters: a stale row would make the next read try to decrypt bytes
      // that were never encrypted.
      const committedId = previous?.id ?? staging.object_id;
      if (staging.sse_algorithm && staging.sse_iv) {
        this.db
          .query(
            `INSERT INTO object_encryption
               (object_id, sse_algorithm, kms_key_id, kms_key_version,
                wrapped_data_key, iv, customer_key_md5, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(object_id) DO UPDATE SET
               sse_algorithm = excluded.sse_algorithm,
               kms_key_id = excluded.kms_key_id,
               kms_key_version = excluded.kms_key_version,
               wrapped_data_key = excluded.wrapped_data_key,
               iv = excluded.iv,
               customer_key_md5 = excluded.customer_key_md5`,
          )
          .run(
            committedId,
            staging.sse_algorithm,
            staging.sse_kms_key_id,
            staging.sse_kms_key_version,
            staging.sse_wrapped_data_key,
            staging.sse_iv,
            staging.sse_customer_key_md5,
            now,
          );
      } else {
        this.db.query("DELETE FROM object_encryption WHERE object_id = ?").run(committedId);
      }

      // A retained version still references the previous Drive file, so
      // deleting it would destroy that version's bytes.
      if (!archivePrevious && previous && previous.drive_file_id !== staging.new_drive_file_id) {
        this.db
          .query(
            `INSERT INTO pending_cleanup
               (id, user_id, resource_type, resource_id, reason,
                attempts, next_attempt_at, created_at, drive_target_id)
             VALUES (?, ?, 'drive_file', ?, 'object_overwrite_old_file', 0, ?, ?, ?)`,
          )
          .run(
            `cln_${crypto.randomUUID().replace(/-/g, "")}`,
            staging.user_id,
            previous.drive_file_id,
            now,
            now,
            staging.drive_target_id,
          );
      }
      // Writing a key clears any delete marker that was hiding it: the object
      // is current again, so no marker may still claim to be latest.
      this.db
        .query(
          "UPDATE object_versions SET is_latest = 0 WHERE bucket_id = ? AND object_key = ?",
        )
        .run(staging.bucket_id, staging.object_key);

      this.db
        .query(
          `UPDATE object_staging
              SET status = 'committed', last_error = NULL, updated_at = ?
            WHERE id = ?`,
        )
        .run(now, staging.id);
      result = {
        current: this.findByKey(staging.bucket_id, staging.object_key)!,
        previous,
        archivedPrevious: archivePrevious,
      };
    });
    tx();
    if (!result) throw new Error("staging commit did not produce an object");
    return result;
  }

  markStatus(userId: string, objectId: string, status: ObjectStatus): boolean {
    const changes = this.db
      .query(
        `UPDATE objects
            SET status = ?, updated_at = ?
          WHERE id = ?
            AND bucket_id IN (SELECT id FROM buckets WHERE user_id = ?)`,
      )
      .run(status, nowIso(), objectId, userId).changes;
    return changes > 0;
  }

  /** Rows to reconcile against Drive, in ownership-scoped batches. */
  listForReconcile(
    userId: string,
    opts: { limit: number; afterUpdated?: string; onlyStatus?: ObjectStatus[] },
  ): ObjectRow[] {
    const statuses = opts.onlyStatus ?? ["active", "missing", "externally_modified"];
    const placeholders = statuses.map(() => "?").join(",");
    const after = opts.afterUpdated ?? "";
    const params: (string | number)[] = [
      userId,
      after,
      ...statuses,
      opts.limit,
    ];
    return this.db
      .query<ObjectRow, (string | number)[]>(
        `SELECT o.* FROM objects o
           JOIN buckets b ON b.id = o.bucket_id
          WHERE b.user_id = ?
            AND o.updated_at > ?
            AND o.status IN (${placeholders})
          ORDER BY o.updated_at ASC
          LIMIT ?`,
      )
      .all(...params);
  }

  /** Prefix-filtered, byte-ordered page. limit+1 fetched to detect hasMore. */
  listByBucket(
    bucketId: string,
    opts: { prefix?: string; afterKey?: string; limit: number },
  ): ListPage {
    const prefix = opts.prefix ?? "";
    const afterKey = opts.afterKey ?? "";
    const prefixLength = [...prefix].length;
    const rows = this.db
      .query<ObjectRow, [string, number, string, string, number]>(
        `SELECT * FROM objects
          WHERE bucket_id = ?
            AND status = 'active'
            AND substr(object_key, 1, ?) = ? COLLATE BINARY
            AND object_key > ? COLLATE BINARY
          ORDER BY object_key COLLATE BINARY ASC
          LIMIT ?`,
      )
      .all(bucketId, prefixLength, prefix, afterKey, opts.limit + 1);

    const hasMore = rows.length > opts.limit;
    return { items: hasMore ? rows.slice(0, opts.limit) : rows, hasMore };
  }

  /**
   * List objects with prefix + optional delimiter. `afterKey` is the internal
   * raw cursor used by V2 continuation tokens; `startAfter` is the external
   * logical marker used by V1 marker and V2 start-after.
   */
  listObjects(input: {
    bucketId: string;
    prefix: string;
    delimiter: string;
    afterKey: string;
    startAfter: string;
    maxKeys: number;
  }): ListObjectsResult {
    const keys: ObjectRow[] = [];
    const commonPrefixes: string[] = [];
    let after = input.afterKey;
    let resumeAfter: string | null = null;
    let visibleMarker: string | null = null;
    const MAX = "\u{10FFFF}";
    const prefixLength = [...input.prefix].length;

    const nextCandidate = (cursor: string): { row: ObjectRow; commonPrefix: string | null } | null => {
      while (true) {
        const row = this.db
          .query<ObjectRow, [string, number, string, string]>(
            `SELECT * FROM objects
              WHERE bucket_id = ?
                AND status = 'active'
                AND substr(object_key, 1, ?) = ? COLLATE BINARY
                AND object_key > ? COLLATE BINARY
              ORDER BY object_key COLLATE BINARY ASC
              LIMIT 1`,
          )
          .get(input.bucketId, prefixLength, input.prefix, cursor);
        if (!row) return null;
        if (input.delimiter) {
          const rest = [...row.object_key].slice(prefixLength).join("");
          const delimiterIndex = rest.indexOf(input.delimiter);
          if (delimiterIndex !== -1) {
            const commonPrefix =
              input.prefix + rest.slice(0, delimiterIndex + input.delimiter.length);
            if (commonPrefix <= input.startAfter) {
              cursor = commonPrefix + MAX;
              continue;
            }
            return { row, commonPrefix };
          }
        }
        if (row.object_key <= input.startAfter) {
          cursor = row.object_key;
          continue;
        }
        return { row, commonPrefix: null };
      }
    };

    if (input.maxKeys === 0) {
      return {
        keys,
        commonPrefixes,
        isTruncated: false,
        nextAfterKey: null,
        nextMarker: null,
      };
    }

    while (keys.length + commonPrefixes.length < input.maxKeys) {
      const candidate = nextCandidate(after);
      if (!candidate) break;
      if (candidate.commonPrefix) {
        commonPrefixes.push(candidate.commonPrefix);
        after = candidate.commonPrefix + MAX;
        resumeAfter = after;
        visibleMarker = candidate.commonPrefix;
      } else {
        keys.push(candidate.row);
        after = candidate.row.object_key;
        resumeAfter = after;
        visibleMarker = after;
      }
    }

    const isTruncated = resumeAfter !== null && nextCandidate(resumeAfter) !== null;
    return {
      keys,
      commonPrefixes,
      isTruncated,
      nextAfterKey: isTruncated ? resumeAfter : null,
      nextMarker: isTruncated ? visibleMarker : null,
    };
  }

  listObjectsV2(input: {
    bucketId: string;
    prefix: string;
    delimiter: string;
    afterKey: string;
    maxKeys: number;
  }): ListObjectsResult {
    return this.listObjects({ ...input, startAfter: input.afterKey });
  }

  setAcl(bucketId: string, objectKey: string, acl: ObjectAclName): boolean {
    return (
      this.db
        .query(
          `UPDATE objects SET acl = ?, updated_at = ?
            WHERE bucket_id = ? AND object_key = ? AND status = 'active'`,
        )
        .run(acl, nowIso(), bucketId, objectKey).changes > 0
    );
  }

  countActive(bucketId: string): number {
    const row = this.db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) AS c FROM objects WHERE bucket_id = ? AND status = 'active'",
      )
      .get(bucketId);
    return row?.c ?? 0;
  }

  totalBytesForUser(userId: string): number {
    const row = this.db
      .query<{ s: number | null }, [string]>(
        `SELECT COALESCE(SUM(o.size_bytes), 0) AS s FROM objects o
           JOIN buckets b ON b.id = o.bucket_id
          WHERE b.user_id = ? AND o.status = 'active'`,
      )
      .get(userId);
    return row?.s ?? 0;
  }
}
