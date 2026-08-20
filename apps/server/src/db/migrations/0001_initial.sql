-- Migration 0001: initial schema (AGENTS.md §9).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  hosted_domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE oauth_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_refresh_token TEXT NOT NULL,
  granted_scopes TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 1,
  last_refresh_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_secret TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT,
  ip_hash TEXT
);

CREATE TABLE drive_roots (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  drive_folder_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  verified_at TEXT NOT NULL
);

CREATE TABLE s3_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_key_id TEXT NOT NULL UNIQUE,
  encrypted_secret_key TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX idx_s3_credentials_user
  ON s3_credentials(user_id);

CREATE TABLE buckets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'us-east-1',
  drive_folder_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('creating', 'active', 'deleting', 'error')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, name)
);

CREATE INDEX idx_buckets_user
  ON buckets(user_id, name);

CREATE TABLE objects (
  id TEXT PRIMARY KEY,
  bucket_id TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  drive_file_id TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  etag TEXT NOT NULL,
  checksum_sha256 TEXT,
  storage_class TEXT NOT NULL DEFAULT 'STANDARD',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'missing', 'externally_modified', 'deleting', 'error')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  cache_control TEXT,
  content_disposition TEXT,
  content_encoding TEXT,
  content_language TEXT,
  expires_at TEXT,
  last_modified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(bucket_id, object_key)
);

CREATE INDEX idx_objects_listing
  ON objects(bucket_id, object_key);

CREATE TABLE multipart_uploads (
  id TEXT PRIMARY KEY,
  bucket_id TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'completing', 'completed', 'aborted', 'expired')),
  initiated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE multipart_parts (
  upload_id TEXT NOT NULL REFERENCES multipart_uploads(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  temp_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  etag TEXT NOT NULL,
  checksum_sha256 TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(upload_id, part_number)
);

CREATE TABLE pending_cleanup (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL
    CHECK (resource_type IN ('drive_file', 'temp_file')),
  resource_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  credential_id TEXT REFERENCES s3_credentials(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  bucket_name TEXT,
  object_key TEXT,
  status_code INTEGER,
  request_id TEXT NOT NULL,
  bytes_in INTEGER,
  bytes_out INTEGER,
  ip_hash TEXT,
  user_agent TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_logs_user_time
  ON audit_logs(user_id, created_at DESC);
