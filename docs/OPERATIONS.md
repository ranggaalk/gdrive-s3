# Operations runbook

This runbook covers SQLite backup/restore, encryption keys, restart safety,
Google Drive failure handling, and routine checks for DriveS3 Gateway.
Commands assume WSL and Bun in `$HOME/.bun/bin`.

## 1. Operational invariants

- SQLite is the namespace source of truth (`bucket/key → Drive fileId`).
- Google Drive stores object bytes; it is not used for S3 listing.
- `MASTER_ENCRYPTION_KEY` must remain the same across backup/restore. It protects
  OAuth refresh tokens, S3 secret keys (the gateway's own and those of S3 backup
  destinations), TOTP and KMS key material, and backup archives. A backup made with a recovery passphrase can give the key back
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

## 9. Backup destinations: S3 and rclone

A bucket backup (Objects > Backup) can go to a linked Google Drive account, an
S3-compatible bucket, or an rclone remote. All three share one queue and one
per-object ledger, so a repeat run copies only what is new or changed, and none
of them ever deletes from the destination: an object deleted from the gateway
keeps its copy.

**Layout.** S3 and rclone copies land at `<prefix>/<bucket name>/<object key>`,
so `aws s3 sync s3://<dest>/<prefix>/<bucket>/ …` or `rclone copy` restores
them with no gateway involved. A changed object overwrites its key. Each
destination also gets a small `<prefix>/.drives3-backup.json`, rewritten by
every connection test.

**Encryption.** S3 and rclone copies are plaintext: SSE-S3 and SSE-KMS objects
are decrypted on the way out, exactly as GetObject serves them, because a copy
that needs this gateway's database to read is not much of a backup. Turn on
encryption at the destination. SSE-C objects cannot be copied (the customer key
is never stored) and show up as failed in the run. Drive copies are unchanged:
the bytes as stored.

**S3 destinations** are added by each user from the Backup page; nothing to
configure. The secret key is sealed under `MASTER_ENCRYPTION_KEY`. The key only
needs `s3:PutObject` and multipart upload on the prefix; add a lifecycle rule
that aborts incomplete multipart uploads after a day or two, for runs
interrupted mid-object. By default an endpoint must be `https://` and resolve to
a public address, so a dashboard user cannot aim the gateway at the host's own
network; `BACKUP_S3_ALLOW_PRIVATE_ENDPOINTS=true` lifts both for a LAN MinIO.
`BACKUP_S3_PART_SIZE_MB` (default 16) is the multipart part size and the memory
each running copy holds.

**rclone destinations** use remotes the operator defines; users only pick one
and a folder under it. An rclone config can run commands on the host (sftp's
`ssh` option) and write to its disk (the `local` backend), so it is never taken
from a user.

1. Build the image with rclone: `INSTALL_RCLONE=true` in `.env`, then
   `docker compose build`. (Outside Docker, install rclone on the host.)
2. Write the remotes with `rclone config` somewhere, then put the file at
   `./rclone/rclone.conf`, owned by uid 1010, and uncomment the `./rclone`
   volume in `docker-compose.yml`. Remotes that refresh OAuth tokens
   (OneDrive, Dropbox, Google Drive) rewrite this file, so it must stay
   writable; static ones (SFTP with a key, WebDAV, S3) can be read-only.
3. In `.env`: `RCLONE_CONFIG=/app/rclone/rclone.conf` and
   `BACKUP_RCLONE_REMOTES=nas,offsite` — the remote names users may choose.
   Prefer remotes rooted where backups belong (an `alias` remote, or an
   sftp user confined to one directory): user paths cannot contain `..`, but
   the remote decides everything else.

rclone runs as `rclone rcat --size <n> <remote>:<path>` per object, with only
`PATH`, `HOME`, proxy, certificate and `RCLONE_*` variables in its environment.
Taking a remote off `BACKUP_RCLONE_REMOTES` stops destinations already saved
against it too.

**When a destination fails.** Rejected credentials, a missing bucket or remote,
or an unreachable endpoint fail the whole run at once and mark the destination
`error` without charging any object a retry. Fix the cause (or, for S3, replace
the key from the destination's Edit dialog) and run the backup again; a run that
reaches the destination clears the error. An object the destination cannot
hold — a key with `.` or `..` segments, or one over S3's 1024-byte limit --
fails on its own and the run carries on.

## 10. Scheduled backups

A schedule belongs to one bucket and one destination, and is managed from the
Backup page (or Objects > Backup for one bucket). When it falls due it queues
an ordinary run — the same worker, ledger and history as a manual run — so only
new or changed objects are copied.

- **Timing.** Every N minutes or hours (at least
  `BACKUP_SCHEDULE_MIN_INTERVAL_MINUTES`, default 15), daily at HH:MM, or
  weekly on chosen days at HH:MM. Clock times are read in the schedule's IANA
  time zone (`Asia/Jakarta`, …); a time a DST change skips runs just after the
  jump, and one it repeats runs once.
- **Nothing changed.** By default a slot with nothing to copy is skipped
  without creating a run, so an "every 15 minutes" schedule is close to
  continuous backup without flooding the history.
- **Downtime.** Slots missed while the gateway was down fire once when it is
  back, and the next slot is counted from then — never a burst of catch-up
  runs.
- **Overlap.** A slot that finds the previous run still going is skipped; a
  slot can never queue two runs, even with two processes on one database.
- **Priority.** Runs started by hand are worked on before scheduled ones.
- **Failures.** A run that fails, or a slot whose Drive destination needs
  reconnecting, counts against the schedule. After
  `BACKUP_SCHEDULE_MAX_FAILURES` (default 5) in a row it switches itself off and
  shows why on the Backup page; switching it back on clears the count. A
  schedule whose bucket is gone or no longer its owner's pauses straight away.
- **History.** Finished runs older than `BACKUP_HISTORY_RETENTION_DAYS`
  (default 90; `0` keeps everything) are pruned hourly. The latest run of every
  bucket and destination stays regardless, and the per-object ledger is never
  pruned.

The scheduler checks for due schedules every `BACKUP_SCHEDULER_TICK_SECONDS`
(default 60). `BACKUP_SCHEDULER_ENABLED=false` stops schedules firing without
touching them — useful while restoring or migrating. Everything it needs is in
SQLite; it needs no Redis or host cron. Scheduled runs pause and resume with
the gateway like any other run.

## 11. Scheduled database snapshots

Bucket backups copy objects; they do not copy the database that maps bucket
keys to Drive files, or the S3 credentials and KMS keys. **Settings → Scheduled
database snapshots** (admins only) ships that too: on a schedule — hourly at
most, daily by default — the gateway takes the same encrypted archive
`db:backup` writes and uploads it, with its `.manifest.json`, to one of the
admin's own backup destinations, under `<prefix>/_gateway-database/`.

- **How.** The archive is made by running the bundled `db:backup` tool
  (`dist/scripts/backup-sqlite.js` in the image) as a child process, so the
  heavy work — VACUUM INTO, gzip, scrypt — never stalls S3 requests. It is
  written next to the database first (`data/.db-snapshot-*`, removed after),
  so the data volume needs room for one archive. `BACKUP_SQLITE_SCRIPT`
  overrides where the tool is found, for custom packaging.
- **Key recovery.** With `BACKUP_PASSPHRASE` set, every snapshot carries the
  master key wrapped under it and can be restored with the passphrase alone;
  without it, only with `MASTER_ENCRYPTION_KEY`, and the Settings card says so.
  Keep the passphrase off the server as well.
- **Retention.** The newest N snapshots (default 14) are kept at the
  destination. Older ones are deleted — only files the gateway recorded
  writing, never anything else there.
- **Failures.** A failed snapshot shows its reason on the card; one cut off by
  a restart is marked interrupted at the next start. `BACKUP_SCHEDULER_ENABLED`
  switches snapshots off along with bucket schedules.

To rebuild from a snapshot, fetch an archive and its manifest from the
destination, then restore as in section 3 (section 3.1 if the new host lacks
the old key):

```bash
aws s3 cp s3://<bucket>/<prefix>/_gateway-database/drives3-<timestamp>.sqlite.gz.enc .
aws s3 cp s3://<bucket>/<prefix>/_gateway-database/drives3-<timestamp>.sqlite.gz.enc.manifest.json .
bun run db:restore -- --input drives3-<timestamp>.sqlite.gz.enc --passphrase
```

(`rclone copy <remote>:<path>/_gateway-database/ .` does the same for an rclone
destination; on Drive the folder is `_gateway-database` inside the backup
root.)

