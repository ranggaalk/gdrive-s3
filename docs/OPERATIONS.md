# Operations runbook

This runbook covers SQLite backup/restore, encryption keys, restart safety,
Google Drive failure handling, and routine checks for DriveS3 Gateway.
Commands assume WSL and Bun in `$HOME/.bun/bin`.

## 1. Operational invariants

- SQLite is the namespace source of truth (`bucket/key → Drive fileId`).
- Google Drive stores object bytes; it is not used for S3 listing.
- `MASTER_ENCRYPTION_KEY` must remain the same across backup/restore. It protects
  OAuth refresh tokens, S3 secret keys, and backup archives.
- `data/multipart/` contains live multipart parts. Do not delete it during a
  restart or restore unless all multipart uploads have expired/been aborted.
- Run one gateway process per SQLite database. Do not put SQLite or multipart
  temp storage on NFS/network filesystems.

## 2. Encrypted SQLite backup

The backup command uses SQLite `VACUUM INTO` for a consistent snapshot, gzip
compression, and AES-256-GCM encryption with a purpose-bound AAD string.

```bash
export PATH="$HOME/.bun/bin:$PATH"
export MASTER_ENCRYPTION_KEY='<same base64 key used by the app>'

bun run db:backup -- \
  --source ./data/app.sqlite \
  --out ./backups
```

Outputs:

- `drives3-<timestamp>.sqlite.gz.enc` — encrypted snapshot (mode `0600`).
- matching `.manifest.json` — SHA-256, byte size, migration version, integrity.

Recommended cadence:

- hourly for active gateways, at least daily for low-volume instances;
- keep daily/weekly/monthly retention separately;
- copy encrypted archives off-host;
- monitor failed backup jobs and free disk space;
- periodically test restore into a temporary path.

`VACUUM INTO` may contend with the SQLite writer. Run during a low-traffic
window; for upgrades, stop the gateway first.

## 3. Restore

1. Stop the gateway cleanly (SIGTERM). The server drains workers and runs a WAL
   checkpoint.
2. Copy the current database and `data/multipart/` aside.
3. Use the exact `MASTER_ENCRYPTION_KEY` that created the backup.
4. Restore to a new path first:

```bash
export MASTER_ENCRYPTION_KEY='<original base64 key>'
bun run db:restore -- \
  --input ./backups/drives3-<timestamp>.sqlite.gz.enc \
  --target ./data/restored.sqlite
```

5. The restore tool validates the manifest SHA-256, AES-GCM tag, gzip stream,
   SQLite `PRAGMA integrity_check`, and applies pending migrations.
6. Set `SQLITE_PATH=./data/restored.sqlite`, start the gateway, and verify:
   - `/health/live` = 200;
   - `/health/ready` = 200;
   - dashboard bucket/object counts;
   - one existing S3 GET and one test PUT/DELETE;
   - cleanup and multipart backlog.
7. Keep the prior database until the restore has been stable for the chosen
   rollback window.

To deliberately replace an existing target, pass `--force`. The write still
uses a temporary file and atomic rename.

## 4. Key management

- Generate a 32-byte key: `openssl rand -base64 32`.
- Store it in a secret manager or protected environment file, never source
  control, logs, shell history, or backup manifests.
- Losing the key makes refresh tokens, S3 secrets, and encrypted backups
  unrecoverable.
- Do not rotate `MASTER_ENCRYPTION_KEY` by simply changing the environment
  variable. Existing envelopes would become unreadable. A future re-wrap tool
  must decrypt/re-encrypt every OAuth/S3 row and create a fresh backup.
- Rotate `SESSION_SECRET` independently; doing so invalidates existing sessions
  and changes IP hashes but does not affect object metadata.

## 5. Multipart/temp storage

Capacity planning depends on peak concurrent uploads, multipart TTL, and client
part size. Alert before the volume fills. The expiry worker:

1. marks expired open uploads;
2. atomically enqueues part paths into `pending_cleanup`;
3. deletes files only after confirming paths stay under `MULTIPART_TEMP_DIR`;
4. removes empty upload directories.

If the server crashes, leave `MULTIPART_TEMP_DIR` intact and restart normally;
the expiry/cleanup workers resume from SQLite.

## 6. Failure and backlog checks

- Google 401/token revoked: user reconnects from the dashboard.
- Google rate limit: request maps to S3 `SlowDown`; client should retry with
  backoff.
- Google storage quota: maps to `ServiceUnavailable`; free Drive space or
  increase the user's quota.
- Missing/trashed Drive file: run Reconcile Drive; SQLite object status becomes
  `missing` while the namespace row remains available for audit.
- Growing `pending_cleanup`: check Drive connectivity and credentials, then let
  the bounded exponential-backoff worker retry. Do not manually delete queue
  rows unless the referenced resource is proven gone.

## 7. One-time Drive imports

Historical imports are explicit owner-triggered jobs, not bidirectional sync.
SQLite still owns the S3 namespace and Drive listing is used only while scanning
the selected source folder.

- The source is never moved, renamed, trashed, or adopted as an S3 object.
- Folder paths become relative S3 keys; `%` and `/` inside a Drive name are
  escaped as `%25` and `%2F` per path segment.
- Existing destination keys and duplicate source paths are reported as conflicts
  and are never overwritten.
- Google-native files, shortcuts, empty folders, internal DriveS3 markers, and
  non-downloadable files are reported/skipped.
- Scan pages and item progress are durable. After restart, the bounded import
  worker resumes queued/running jobs. Cancellation stops at a page/item boundary
  and does not roll back completed objects.
- `DRIVE_IMPORT_PAGE_SIZE`, `DRIVE_IMPORT_BATCH_SIZE`, and
  `DRIVE_IMPORT_INTERVAL_MS` control Drive pagination and worker cadence.

When a job fails, inspect its dashboard report and OAuth/Shared Drive access.
Do not edit provider page tokens or import rows manually. Retry by correcting the
access/problem and selecting a new source/bucket combination; a source folder is
registered only once per destination bucket to prevent accidental duplicate
imports.

## 8. Clock and SigV4

Keep host time synchronized with NTP. Header-signed SigV4 requests tolerate only
the configured clock-skew window (currently 15 minutes); presigned URLs also
expire according to `X-Amz-Date + X-Amz-Expires`.
