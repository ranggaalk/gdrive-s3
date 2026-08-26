-- Multi-drive backup: link a second Google account (not the login identity)
-- as a manual backup destination for a bucket's objects. Built so a future
-- scheduler can drive the same `backup_transfers` queue automatically.

CREATE TABLE backup_accounts (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  granted_scopes TEXT NOT NULL,
  root_folder_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'reauthorization_required', 'error')),
  last_error TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_backup_accounts_owner ON backup_accounts(owner_user_id);

CREATE TABLE backup_transfers (
  id TEXT PRIMARY KEY,
  bucket_id TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  backup_account_id TEXT NOT NULL REFERENCES backup_accounts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  destination_folder_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'cancel_requested', 'completed', 'cancelled', 'failed')),
  total_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  copied_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);
-- Only one active run per (bucket, destination) at a time.
CREATE UNIQUE INDEX idx_backup_transfers_one_active
  ON backup_transfers(bucket_id, backup_account_id)
  WHERE status IN ('queued', 'running', 'cancel_requested');
CREATE INDEX idx_backup_transfers_claim ON backup_transfers(status, updated_at);
CREATE INDEX idx_backup_transfers_bucket ON backup_transfers(bucket_id, created_at DESC);

-- Durable per-object ledger: what has already been copied to which backup
-- destination, keyed to the exact object version (etag) that was copied.
-- This is what makes repeated manual runs (and a future scheduler) copy
-- only what's new or changed, instead of re-uploading everything each time.
CREATE TABLE backup_object_status (
  backup_account_id TEXT NOT NULL REFERENCES backup_accounts(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  object_etag TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('copied', 'failed')),
  destination_file_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_transfer_id TEXT REFERENCES backup_transfers(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (backup_account_id, object_id)
);
CREATE INDEX idx_backup_object_status_transfer ON backup_object_status(last_transfer_id);
