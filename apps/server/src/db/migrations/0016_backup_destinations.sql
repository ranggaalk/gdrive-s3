-- Backup destinations beyond Google Drive: S3-compatible object storage, and
-- rclone remotes the operator defines in their own rclone.conf.
--
-- backup_accounts is extended in place rather than rebuilt. backup_transfers
-- and backup_object_status both reference it ON DELETE CASCADE, so dropping and
-- recreating it would take every run and the whole per-object ledger with it --
-- the same trap 0013_versioning.sql describes for `objects`.
--
-- That leaves the Drive-only columns NOT NULL. On a non-Drive row:
--   email                    the destination's display label
--   encrypted_refresh_token  '' (an S3 secret lives in encrypted_secret; an
--                            rclone remote has none -- its credentials are in
--                            the operator's rclone.conf, never in this database)
--   granted_scopes           ''

ALTER TABLE backup_accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'drive'
  CHECK (kind IN ('drive', 's3', 'rclone'));

-- Non-secret settings as JSON: endpoint, region, bucket, prefix and addressing
-- style for S3; remote name and base path for rclone.
ALTER TABLE backup_accounts ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';

-- An S3 destination's secret access key, sealed under MASTER_ENCRYPTION_KEY
-- with AAD "backup-destination-secret:<id>". NULL for every other kind.
ALTER TABLE backup_accounts ADD COLUMN encrypted_secret TEXT;
