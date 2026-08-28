-- Object versioning.
--
-- Note what this migration deliberately does NOT do: it does not rebuild the
-- `objects` table to drop UNIQUE(bucket_id, object_key). Three tables
-- reference objects(id) with ON DELETE CASCADE — public_object_links,
-- backup_object_status, and object_encryption — and PRAGMA foreign_keys is on,
-- so dropping and recreating `objects` would cascade-delete live public links,
-- the backup ledger, and every object's encryption metadata. `defer_foreign_keys`
-- postpones constraint *checking*, not cascade *actions*, so it is no help.
--
-- Instead `objects` keeps meaning "the current version of this key", exactly as
-- it does today, and superseded versions live in their own table. A bucket with
-- versioning Disabled therefore behaves bit-for-bit as it did before.

ALTER TABLE buckets ADD COLUMN versioning TEXT NOT NULL DEFAULT 'Disabled'
  CHECK (versioning IN ('Disabled', 'Enabled', 'Suspended'));

-- 'null' is the literal version id S3 reports for objects written while
-- versioning was off, which is why it is a string rather than SQL NULL.
ALTER TABLE objects ADD COLUMN version_id TEXT NOT NULL DEFAULT 'null';

-- Superseded versions and delete markers. A delete marker carries no bytes,
-- so its storage columns are nullable.
CREATE TABLE object_versions (
  id TEXT PRIMARY KEY,
  bucket_id TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  version_id TEXT NOT NULL,
  drive_file_id TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  etag TEXT,
  checksum_sha256 TEXT,
  storage_class TEXT NOT NULL DEFAULT 'STANDARD',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  cache_control TEXT,
  content_disposition TEXT,
  content_encoding TEXT,
  content_language TEXT,
  expires_at TEXT,
  acl TEXT NOT NULL DEFAULT 'private',
  is_delete_marker INTEGER NOT NULL DEFAULT 0,
  -- Only a delete marker is ever "latest" here: while a real version is
  -- current it lives in `objects`, not in this table.
  is_latest INTEGER NOT NULL DEFAULT 0,
  -- Encryption travels with the version. object_encryption keys off
  -- objects(id), which a superseded version no longer has.
  sse_algorithm TEXT,
  sse_kms_key_id TEXT,
  sse_kms_key_version INTEGER,
  sse_wrapped_data_key TEXT,
  sse_iv TEXT,
  sse_customer_key_md5 TEXT,
  last_modified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(bucket_id, object_key, version_id)
);

-- ListObjectVersions walks key then version, newest first.
CREATE INDEX idx_object_versions_listing
  ON object_versions(bucket_id, object_key, created_at DESC);

-- Finding the delete marker that is currently hiding a key.
CREATE INDEX idx_object_versions_latest
  ON object_versions(bucket_id, object_key, is_latest);
