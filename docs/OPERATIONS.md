# Operations runbook

This runbook covers SQLite backup/restore, encryption keys, restart safety,
Google Drive failure handling, and routine checks for DriveS3 Gateway.
Commands assume WSL and Bun in `$HOME/.bun/bin`.

## 1. Operational invariants

- SQLite is the namespace source of truth (`bucket/key → Drive fileId`).
- Google Drive stores object bytes; it is not used for S3 listing.
- `MASTER_ENCRYPTION_KEY` must remain the same across backup/restore. It protects
  OAuth refresh tokens, S3 secret keys, TOTP and KMS key material, and backup
  archives. A backup made with a recovery passphrase can give the key back
  (section 3.1); one made without cannot.
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

Under Docker Compose the same tool is bundled in the image; run it in the
container (DEPLOY.md §6):

```bash
docker compose exec gateway bun dist/scripts/backup-sqlite.js --out /app/data/backups
```

Run interactively, it asks for a **recovery passphrase** (twice, not echoed).
The archive then also carries `MASTER_ENCRYPTION_KEY`, encrypted under a key
derived from that passphrase with scrypt (N=2^17, r=8, p=1), so a host that
has lost the key can restore from the archive and the passphrase alone.

- At least 12 characters. Anyone holding an archive can try to guess the
  passphrase offline, and scrypt only slows each guess down. A sentence of
  several unrelated words works better than a short complex string.
- Keep the passphrase somewhere other than the server: a password manager, or
  on paper. It is only useful on a day the server is gone.
- Scheduled (non-interactive) backups read it from `BACKUP_PASSPHRASE`. A host
  that can read that variable can already read `MASTER_ENCRYPTION_KEY`, so
  setting it there costs nothing — but it is not a substitute for the copy
  kept elsewhere.
- With neither a terminal nor `BACKUP_PASSPHRASE`, the backup still runs,
  warns, and can only be restored with the key. `--no-recovery` opts out
  explicitly.

Before writing anything, the backup checks that `MASTER_ENCRYPTION_KEY` opens
at least one secret sealed in the database. A wrong key would otherwise
produce an archive that restores cleanly but leaves every secret unreadable —
and, with key recovery, would faithfully hand back that wrong key.

Outputs:

- `drives3-<timestamp>.sqlite.gz.enc` — encrypted snapshot (mode `0600`).
- matching `.manifest.json` — SHA-256, byte size, migration version, integrity,
  and `keyRecovery` (`passphrase` or `none`).

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

### 3.1 Restore on a host that lost the master key

For an archive made with a recovery passphrase (its manifest says
`"keyRecovery": "passphrase"`):

```bash
bun run db:restore -- \
  --input ./backups/drives3-<timestamp>.sqlite.gz.enc \
  --target ./data/app.sqlite
```

Under Docker Compose, with the gateway stopped:
`docker compose run --rm gateway bun dist/scripts/restore-sqlite.js --input /app/data/backups/<archive>`.

With `MASTER_ENCRYPTION_KEY` unset, the tool asks for the passphrase, restores,
and prints the recovered key. If the new host's environment already holds a
freshly generated key, that key will not open the archive; add `--passphrase`
to use the passphrase instead. `--key-out FILE` writes
`MASTER_ENCRYPTION_KEY=<key>` to a new `0600` file rather than printing it, and
`BACKUP_PASSPHRASE` supplies the passphrase without a prompt.

Put the recovered key in the gateway's environment **before** starting it:
the database's secrets are sealed under that key, not under any new one.

Archives from before key recovery existed restore exactly as before, with the
original key.

## 4. Key management

- Generate a 32-byte key: `openssl rand -base64 32`.
- Store it in a secret manager or protected environment file, never source
  control, logs, shell history, or backup manifests.
- Losing the key makes refresh tokens, S3 secrets, and encrypted backups
  unrecoverable — unless a backup was made with a recovery passphrase
  (sections 2 and 3.1). Keep at least one such archive off-host.
- Do not rotate `MASTER_ENCRYPTION_KEY` by simply changing the environment
  variable. Existing envelopes would become unreadable. A future re-wrap tool
  must decrypt/re-encrypt every OAuth/S3 row and create a fresh backup.
- Rotate `SESSION_SECRET` independently. Sessions survive it (the cookie is
  matched by a plain SHA-256 of its value); it changes IP hashes and
  invalidates in-flight S3 list continuation tokens, and does not affect object
  metadata.

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
