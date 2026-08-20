-- Migration 0002: durable staging + cleanup/reconciliation indexes (AGENTS.md §8, §18, §22).

CREATE TABLE object_staging (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket_id TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  object_id TEXT NOT NULL,
  new_drive_file_id TEXT,
  old_drive_file_id TEXT,
  size_bytes INTEGER,
  etag TEXT,
  checksum_sha256 TEXT,
  content_type TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  cache_control TEXT,
  content_disposition TEXT,
  content_encoding TEXT,
  content_language TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'uploading'
    CHECK (status IN ('uploading', 'uploaded', 'committed', 'failed')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_object_staging_recovery
  ON object_staging(status, updated_at);

CREATE INDEX idx_pending_cleanup_due
  ON pending_cleanup(next_attempt_at, attempts);

CREATE INDEX idx_objects_reconcile
  ON objects(status, updated_at);
