// Superseded object versions and delete markers.
//
// The invariant that keeps this simple: the *current* version of a key always
// lives in `objects`, never here. This table holds only what is no longer
// current, plus delete markers — which are the one kind of row here that can
// be `is_latest`, because a delete marker has no body to store in `objects`.

import type { Database } from "bun:sqlite";
import { nowIso } from "../../util/ids.ts";
import type { ObjectRow } from "./objects.ts";

export interface ObjectVersionRow {
  id: string;
  bucket_id: string;
  object_key: string;
  version_id: string;
  drive_file_id: string | null;
  size_bytes: number;
  content_type: string;
  etag: string | null;
  checksum_sha256: string | null;
  storage_class: string;
  metadata_json: string;
  cache_control: string | null;
  content_disposition: string | null;
  content_encoding: string | null;
  content_language: string | null;
  expires_at: string | null;
  acl: string;
  is_delete_marker: number;
  is_latest: number;
  sse_algorithm: string | null;
  sse_kms_key_id: string | null;
  sse_kms_key_version: number | null;
  sse_wrapped_data_key: string | null;
  sse_iv: string | null;
  sse_customer_key_md5: string | null;
  last_modified_at: string;
  created_at: string;
}

/** A row from either table, flattened for listing and lookup. */
export interface AnyVersion {
  versionId: string;
  key: string;
  isDeleteMarker: boolean;
  isLatest: boolean;
  size: number;
  etag: string | null;
  lastModified: string;
  storageClass: string;
}

export interface ListVersionsResult {
  versions: AnyVersion[];
  commonPrefixes: string[];
  isTruncated: boolean;
  nextKeyMarker: string | null;
  nextVersionIdMarker: string | null;
}

/** Version ids sort lexicographically newest-first, so a listing needs no
 *  join against timestamps to order correctly. */
export function newVersionId(): string {
  // Inverted millisecond clock, then randomness to break ties within a
  // millisecond. Padded so string ordering matches numeric ordering.
  const inverted = (9_999_999_999_999 - Date.now()).toString().padStart(13, "0");
  return `v${inverted}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export class ObjectVersionsRepository {
  constructor(private readonly db: Database) {}

  find(bucketId: string, objectKey: string, versionId: string): ObjectVersionRow | null {
    return (
      this.db
        .query<ObjectVersionRow, [string, string, string]>(
          "SELECT * FROM object_versions WHERE bucket_id = ? AND object_key = ? AND version_id = ?",
        )
        .get(bucketId, objectKey, versionId) ?? null
    );
  }

  /** The delete marker currently hiding a key, if any. */
  findLatestDeleteMarker(bucketId: string, objectKey: string): ObjectVersionRow | null {
    return (
      this.db
        .query<ObjectVersionRow, [string, string]>(
          `SELECT * FROM object_versions
            WHERE bucket_id = ? AND object_key = ? AND is_latest = 1 AND is_delete_marker = 1
            LIMIT 1`,
        )
        .get(bucketId, objectKey) ?? null
    );
  }

  /** Every stored version of one key, newest first. */
  listForKey(bucketId: string, objectKey: string): ObjectVersionRow[] {
    return this.db
      .query<ObjectVersionRow, [string, string]>(
        `SELECT * FROM object_versions
          WHERE bucket_id = ? AND object_key = ?
          ORDER BY version_id ASC`,
      )
      .all(bucketId, objectKey);
  }

  /** Archive the row that is being superseded. */
  archive(input: {
    object: ObjectRow;
    encryption: {
      sse_algorithm: string;
      kms_key_id: string | null;
      kms_key_version: number | null;
      wrapped_data_key: string | null;
      iv: string;
      customer_key_md5: string | null;
    } | null;
  }): ObjectVersionRow {
    const { object } = input;
    const id = `ver_${crypto.randomUUID().replace(/-/g, "")}`;
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
        id,
        object.bucket_id,
        object.object_key,
        object.version_id,
        object.drive_file_id,
        object.size_bytes,
        object.content_type,
        object.etag,
        object.checksum_sha256,
        object.storage_class,
        object.metadata_json,
        object.cache_control,
        object.content_disposition,
        object.content_encoding,
        object.content_language,
        object.expires_at,
        object.acl,
        input.encryption?.sse_algorithm ?? null,
        input.encryption?.kms_key_id ?? null,
        input.encryption?.kms_key_version ?? null,
        input.encryption?.wrapped_data_key ?? null,
        input.encryption?.iv ?? null,
        input.encryption?.customer_key_md5 ?? null,
        object.last_modified_at,
        nowIso(),
      );
    return this.find(object.bucket_id, object.object_key, object.version_id)!;
  }

  insertDeleteMarker(input: {
    bucketId: string;
    objectKey: string;
    versionId: string;
  }): ObjectVersionRow {
    const now = nowIso();
    const id = `ver_${crypto.randomUUID().replace(/-/g, "")}`;
    this.db
      .query(
        `INSERT INTO object_versions
           (id, bucket_id, object_key, version_id, size_bytes, is_delete_marker,
            is_latest, last_modified_at, created_at)
         VALUES (?, ?, ?, ?, 0, 1, 1, ?, ?)`,
      )
      .run(id, input.bucketId, input.objectKey, input.versionId, now, now);
    return this.find(input.bucketId, input.objectKey, input.versionId)!;
  }

  /** Clear the latest flag, used when a marker is removed or superseded. */
  clearLatest(bucketId: string, objectKey: string): void {
    this.db
      .query(
        "UPDATE object_versions SET is_latest = 0 WHERE bucket_id = ? AND object_key = ?",
      )
      .run(bucketId, objectKey);
  }

  delete(bucketId: string, objectKey: string, versionId: string): ObjectVersionRow | null {
    const existing = this.find(bucketId, objectKey, versionId);
    if (!existing) return null;
    this.db
      .query(
        "DELETE FROM object_versions WHERE bucket_id = ? AND object_key = ? AND version_id = ?",
      )
      .run(bucketId, objectKey, versionId);
    return existing;
  }

  /** The newest non-marker version of a key, for restoring after a marker is
   *  deleted. */
  newestVersion(bucketId: string, objectKey: string): ObjectVersionRow | null {
    return (
      this.db
        .query<ObjectVersionRow, [string, string]>(
          `SELECT * FROM object_versions
            WHERE bucket_id = ? AND object_key = ? AND is_delete_marker = 0
            ORDER BY version_id ASC LIMIT 1`,
        )
        .get(bucketId, objectKey) ?? null
    );
  }

  /** Every non-current version in a bucket, for the bulk-prune action. */
  listNonCurrent(bucketId: string, limit = 1000): ObjectVersionRow[] {
    return this.db
      .query<ObjectVersionRow, [string, number]>(
        `SELECT * FROM object_versions
          WHERE bucket_id = ? AND is_delete_marker = 0
          ORDER BY created_at ASC LIMIT ?`,
      )
      .all(bucketId, limit);
  }

  countForBucket(bucketId: string): number {
    const row = this.db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) AS c FROM object_versions WHERE bucket_id = ?",
      )
      .get(bucketId);
    return row?.c ?? 0;
  }

  /**
   * ListObjectVersions: the current objects and the archived versions merged
   * into one key-ordered listing, as S3 reports it.
   */
  listVersions(input: {
    bucketId: string;
    prefix: string;
    delimiter: string;
    keyMarker: string;
    versionIdMarker: string;
    maxKeys: number;
  }): ListVersionsResult {
    const like = `${input.prefix.replace(/[%_\\]/g, "\\$&")}%`;

    const current = this.db
      .query<
        {
          object_key: string;
          version_id: string;
          size_bytes: number;
          etag: string;
          last_modified_at: string;
          storage_class: string;
        },
        [string, string]
      >(
        `SELECT object_key, version_id, size_bytes, etag, last_modified_at, storage_class
           FROM objects
          WHERE bucket_id = ? AND status = 'active' AND object_key LIKE ? ESCAPE '\\'`,
      )
      .all(input.bucketId, like);

    const archived = this.db
      .query<ObjectVersionRow, [string, string]>(
        `SELECT * FROM object_versions
          WHERE bucket_id = ? AND object_key LIKE ? ESCAPE '\\'`,
      )
      .all(input.bucketId, like);

    const merged: AnyVersion[] = [
      ...current.map((row) => ({
        versionId: row.version_id,
        key: row.object_key,
        isDeleteMarker: false,
        // A row in `objects` is by definition the current version.
        isLatest: true,
        size: row.size_bytes,
        etag: row.etag,
        lastModified: row.last_modified_at,
        storageClass: row.storage_class,
      })),
      ...archived.map((row) => ({
        versionId: row.version_id,
        key: row.object_key,
        isDeleteMarker: row.is_delete_marker === 1,
        isLatest: row.is_latest === 1,
        size: row.size_bytes,
        etag: row.etag,
        lastModified: row.last_modified_at,
        storageClass: row.storage_class,
      })),
    ];

    // Key ascending, then version id ascending — which is newest-first, since
    // version ids embed an inverted clock.
    merged.sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0,
    );

    const afterMarker = merged.filter((entry) => {
      if (!input.keyMarker) return true;
      if (entry.key > input.keyMarker) return true;
      if (entry.key < input.keyMarker) return false;
      return input.versionIdMarker ? entry.versionId > input.versionIdMarker : false;
    });

    // Roll up keys under the delimiter, matching ListObjectsV2 semantics.
    const commonPrefixes = new Set<string>();
    const kept: AnyVersion[] = [];
    for (const entry of afterMarker) {
      if (input.delimiter) {
        const rest = entry.key.slice(input.prefix.length);
        const idx = rest.indexOf(input.delimiter);
        if (idx !== -1) {
          commonPrefixes.add(input.prefix + rest.slice(0, idx + input.delimiter.length));
          continue;
        }
      }
      kept.push(entry);
    }

    const page = kept.slice(0, input.maxKeys);
    const isTruncated = kept.length > input.maxKeys;
    const last = page[page.length - 1];
    return {
      versions: page,
      commonPrefixes: [...commonPrefixes].sort(),
      isTruncated,
      nextKeyMarker: isTruncated && last ? last.key : null,
      nextVersionIdMarker: isTruncated && last ? last.versionId : null,
    };
  }
}
