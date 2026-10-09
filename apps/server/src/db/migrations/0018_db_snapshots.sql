-- Scheduled snapshots of the gateway's own database, shipped to one of the
-- admin's backup destinations. A bucket backup copies objects; this copies
-- what makes sense of them -- the namespace, the credentials, the KMS keys --
-- as the same encrypted archive `db:backup` writes, so a lost server can be
-- rebuilt from the destination alone.

-- One row: the gateway has one database, so it has one snapshot schedule.
CREATE TABLE db_snapshot_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  -- Must belong to updated_by, an admin. NULL once that destination is removed.
  backup_account_id TEXT REFERENCES backup_accounts(id) ON DELETE SET NULL,
  frequency TEXT NOT NULL DEFAULT 'daily' CHECK (frequency IN ('interval', 'daily', 'weekly')),
  interval_minutes INTEGER,
  time_of_day TEXT,
  days_of_week TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  -- Snapshots kept at the destination; older ones the gateway made are deleted.
  retain_count INTEGER NOT NULL DEFAULT 14 CHECK (retain_count BETWEEN 1 AND 365),
  next_run_at TEXT,
  last_started_at TEXT,
  last_finished_at TEXT,
  last_status TEXT CHECK (last_status IN ('running', 'completed', 'failed')),
  last_error TEXT,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT
);

-- What each snapshot left at its destination, so retention deletes exactly
-- the files the gateway wrote and nothing else.
CREATE TABLE db_snapshots (
  id TEXT PRIMARY KEY,
  backup_account_id TEXT NOT NULL REFERENCES backup_accounts(id) ON DELETE CASCADE,
  archive_name TEXT NOT NULL,
  -- Where the archive and its manifest landed: an S3 key, an rclone path, a
  -- Drive file id.
  archive_ref TEXT NOT NULL,
  manifest_ref TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  migration_version INTEGER NOT NULL,
  key_recovery TEXT NOT NULL CHECK (key_recovery IN ('passphrase', 'none')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_db_snapshots_account ON db_snapshots(backup_account_id, created_at DESC);
