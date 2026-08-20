-- Durable one-time imports from existing Google Drive folders.

CREATE TABLE drive_import_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket_id TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('my_drive', 'shared_drive')),
  source_drive_id TEXT,
  source_folder_id TEXT NOT NULL,
  source_folder_name TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'scan' CHECK (phase IN ('scan', 'copy')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'cancel_requested', 'completed', 'cancelled', 'failed')),
  discovered_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  unsupported_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((source_kind = 'my_drive' AND source_drive_id IS NULL) OR
         (source_kind = 'shared_drive' AND source_drive_id IS NOT NULL))
);

CREATE UNIQUE INDEX idx_drive_import_source_once
  ON drive_import_jobs(bucket_id, source_kind, source_drive_id, source_folder_id);
CREATE UNIQUE INDEX idx_drive_import_my_source_once
  ON drive_import_jobs(bucket_id, source_folder_id)
  WHERE source_kind = 'my_drive';
CREATE UNIQUE INDEX idx_drive_import_one_active_bucket
  ON drive_import_jobs(bucket_id)
  WHERE status IN ('queued', 'running', 'cancel_requested');
CREATE INDEX idx_drive_import_jobs_claim
  ON drive_import_jobs(status, updated_at);

CREATE TABLE drive_import_folders (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES drive_import_jobs(id) ON DELETE CASCADE,
  source_folder_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  next_page_token TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'scanning', 'completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, source_folder_id)
);

CREATE INDEX idx_drive_import_folders_scan
  ON drive_import_folders(job_id, status, created_at);

CREATE TABLE drive_import_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES drive_import_jobs(id) ON DELETE CASCADE,
  source_file_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_mime_type TEXT NOT NULL,
  source_size_bytes INTEGER,
  source_md5_checksum TEXT,
  source_modified_time TEXT,
  source_version TEXT,
  object_key TEXT NOT NULL,
  key_bytes INTEGER NOT NULL CHECK (key_bytes >= 1),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'importing', 'imported', 'conflict', 'unsupported', 'failed')),
  reason TEXT,
  destination_object_id TEXT REFERENCES objects(id) ON DELETE SET NULL,
  staging_request_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, source_file_id),
  UNIQUE(staging_request_id)
);

CREATE INDEX idx_drive_import_items_work
  ON drive_import_items(job_id, status, created_at);
CREATE INDEX idx_drive_import_items_key
  ON drive_import_items(job_id, object_key);
