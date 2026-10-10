<div align="center">

# DriveS3 Gateway

**Your Google Drive, speaking fluent S3.**

Point the AWS CLI, an AWS SDK, rclone, or MinIO `mc` at your own domain.
Objects land as real files in Google Drive, while SQLite keeps the S3
namespace honest.

![Runtime](https://img.shields.io/badge/runtime-Bun-000000?style=flat-square)
![Language](https://img.shields.io/badge/language-TypeScript-3178C6?style=flat-square)
![Frontend](https://img.shields.io/badge/frontend-React%2019%20%2B%20HeroUI-61DAFB?style=flat-square)
![Storage](https://img.shields.io/badge/storage-SQLite-003B57?style=flat-square)
![Tests](https://img.shields.io/badge/tests-955%20passing-16a34a?style=flat-square)

</div>

## How it works

```mermaid
flowchart LR
    C["S3 clients<br/>AWS CLI · SDK · rclone · mc"] -->|SigV4| G
    D["Dashboard<br/>React 19 + HeroUI"] -->|session + CSRF| G
    G["DriveS3 Gateway<br/>Bun runtime"]
    G --> S[("SQLite<br/>namespace, ACL, audit")]
    G --> GD["Google Drive<br/>object bytes"]
```

Every user acts through their own Google OAuth grant. There is no
service-account backdoor into anyone's Drive, and buckets live either in the
owner's **My Drive** or in an explicitly chosen **Shared Drive**, with per-user
Viewer/Editor access.

## Contents

- [Highlights](#highlights)
- [Compatibility](#compatibility)
- [Quick start](#quick-start)
- [Google OAuth setup](#google-oauth-setup)
- [Optional: virtual-hosted endpoint](#optional-virtual-hosted-endpoint)
- [Drive API quota](#drive-api-quota)
- [Dashboard](#dashboard)
- [Quality gates](#quality-gates)
- [Production deployment](#production-deployment)
- [Architecture constraints](#architecture-constraints)
- [Further reading](#further-reading)

## Highlights

### Security

| | |
|---|---|
| **Two-factor auth** | TOTP enrollment by QR or manual key, single-use recovery codes, and a pending-session gate that blocks the API until the code clears. Verified against the RFC 6238 test vectors. |
| **Scoped login** | Google OAuth gated by Workspace domain and/or an explicit email allowlist, so personal Gmail can be admitted deliberately. |
| **Secrets at rest** | OAuth refresh tokens, S3 secret keys, TOTP secrets, KMS keys, backup-destination credentials, the OAuth client secret set from the dashboard, and database backups are AES-256-GCM encrypted with per-context AAD. Recovery codes are stored only as hashes. |
| **Request hardening** | Session and CSRF protection, SigV4 header plus presigned-query auth, security headers, bounded request bodies, and per-scope rate limits. |
| **Encryption at rest** | Optional server-side encryption per bucket or per object: SSE-S3, SSE-KMS with your own customer master keys, or SSE-C. Ranged reads stay cheap, since the cipher is seekable. |
| **Retention** | Object Lock in GOVERNANCE or COMPLIANCE mode, plus Legal Hold. A COMPLIANCE lock cannot be lifted by anyone, including the bucket owner. |

### S3 data plane

- Path-style CRUD, `ListObjectsV2`, bulk delete, byte-range GET, and
  conditional GET (`If-Match`, `If-None-Match`, `If-Modified-Since`).
- Full multipart upload lifecycle, `CopyObject`, and `UploadPartCopy` — copies
  may be ranged, conditional, versioned, or across two different owners.
- Object versioning with delete markers and undelete.
- ACLs and bucket policies, including anonymous public access when a policy
  or ACL grants it (and `S3_ALLOW_ANONYMOUS=false` to forbid it outright).
- SigV4, SigV4A, presigned URLs, and PresignedPost browser form uploads.
- Optional virtual-hosted addressing (`{bucket}.{domain}`) alongside the
  always-on path-style default.
- Streaming resumable uploads, atomic overwrite, a durable cleanup queue, and
  reconciliation against Drive.

### Dashboard

- **Objects and buckets:** streaming upload, preview, download, delete,
  temporary presigned links, revocable public links, browser upload forms,
  cross-bucket copy, and per-object version history.
- **Access control:** canned ACLs and a bucket policy editor, with a badge on
  any bucket reachable by the anonymous public.
- **Encryption keys:** create, rotate, and disable customer master keys.
  Rotation never strands data — objects record the key version they were
  written under.
- **Credentials:** create, atomic rotate, revoke, and permanently delete
  (revoked keys only), with a one-time download of the new secret.
- **Drive import:** copy an existing Google Drive folder tree into a bucket as
  a one-time, read-only snapshot.
- **Drive API quota:** how much Google Drive API quota is left, read live from
  Google rather than estimated, alongside the calls this gateway actually made.
- **Traffic charts:** bandwidth, request count, and error count over 1h, 24h,
  or 7d, refreshing every 15s, both dashboard-wide and per bucket.
- **Activity log:** cursor-paginated audit trail of control-plane actions.
- **Made to fit:** Indonesian and English throughout, light and dark themes,
  and a color theme picker with custom accent support.

### Bucket backup

Run a manual per-bucket backup to any of three kinds of destination:

- **Another Google Drive account** (a personal Gmail, for example), linked
  through Google's consent screen. Objects are copied into a folder of their
  own on that account.
- **S3-compatible storage**: AWS S3, Cloudflare R2, Backblaze B2, Wasabi,
  MinIO. Copies land at `<prefix>/<bucket>/<key>`, so a plain `aws s3 sync`
  restores them, and the key is tested with a real write before it is saved.
- **An rclone remote** (SFTP, WebDAV, OneDrive, Dropbox, …) from a list the
  operator configures. Users never supply rclone config themselves.

Source files are never modified, nothing is ever deleted from a destination,
and a durable per-object ledger means repeat runs skip anything unchanged.
Setup and caveats are in the
[operations runbook](docs/OPERATIONS.md#9-backup-destinations-s3-and-rclone).

Backups can also run on a **schedule** — every few hours, daily, or weekly at a
set time in the schedule's own time zone — or **on change**: once the bucket
has had no new writes for a quiet period, so a bulk upload is copied whole in
one run, and after a maximum wait for a bucket that never goes quiet. A slot
that finds nothing changed is skipped without leaving an empty run behind, a
schedule that keeps failing pauses itself and says why, and everything lives
in SQLite: no Redis, no host cron, and a restart loses nothing. See
[scheduled backups](docs/OPERATIONS.md#10-scheduled-backups).

The gateway's own database can be shipped the same way: an admin schedules
encrypted snapshots to one of their destinations, so a server lost along with
its disk can be rebuilt from the destination alone.

The Backup page reports on that ledger: totals across the gateway, a rollup per
destination, and a filterable history of every run from every bucket.
Opening a run shows what it did to each individual object — copied or failed,
how many attempts, the error text, and where the copy landed.

### Admin settings

Google OAuth client credentials and the Drive root folder name are editable at
runtime from the dashboard, so rotating them no longer means redeploying with
new environment variables. The same page schedules the encrypted database
snapshots described under [Bucket backup](#bucket-backup).

## Compatibility

This is not a reimplementation of all of Amazon S3, but every feature listed
below is backed by a passing test — the dashboard ships an evidence-based
compatibility matrix, and a row cannot be marked supported without naming the
test that proves it.

| Area | Supported |
|---|---|
| **Addressing** | Path-style (default) and virtual-hosted (opt-in) endpoints |
| **Objects** | Core CRUD, `ListObjectsV2`, byte-range and conditional GET |
| **Multipart** | Full lifecycle, plus `UploadPartCopy` from a byte range |
| **Copy** | `CopyObject` including ranged, conditional, versioned, and cross-user copies |
| **Auth** | SigV4 header and presigned-query, SigV4A (`AWS4-ECDSA-P256-SHA256`), PresignedPost browser forms |
| **Access control** | ACLs and bucket policies, including anonymous public access |
| **Encryption** | SSE-S3, SSE-KMS with local customer master keys, and SSE-C |
| **Versioning** | Object versions, delete markers, and undelete |
| **Retention** | Object Lock (GOVERNANCE and COMPLIANCE) and Legal Hold |
| **Clients** | AWS CLI, rclone, and MinIO `mc` smoke suites |

Known divergences from S3, all deliberate:

- Bucket names are unique **per user**, not globally. An anonymous request to a
  name two owners share is refused rather than resolved to a guess.
- The ETag of an encrypted object stays the MD5 of its plaintext, where S3
  returns an opaque value.
- SSE-C multipart uploads are rejected: the customer key is never stored, and
  `CompleteMultipartUpload` carries no header to resupply it.

Open the dashboard Overview page for the live matrix with test evidence behind
each row.

## Quick start

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun install
cp .env.example .env
# Fill in GOOGLE_*, MASTER_ENCRYPTION_KEY, and SESSION_SECRET.
# See "Google OAuth setup" below.
bun run dev
```

Vite serves the web app on port 5173 and proxies control-plane routes to the
Bun server on port 3000.

## Google OAuth setup

Login is allowed through either (or both) of two independent gates. At least
one must be configured:

| Variable | Admits |
|---|---|
| `GOOGLE_WORKSPACE_DOMAIN` | Any account whose OAuth `hd` claim matches the domain, meaning any member of that Google Workspace org. |
| `ALLOWED_EMAILS` | A comma-separated allowlist of specific addresses, including consumer Gmail accounts, which have no `hd` claim and so cannot satisfy the domain check. |

<details>
<summary><b>Step-by-step Google Cloud Console setup</b></summary>

1. In [Google Cloud Console](https://console.cloud.google.com/), create or
   select a project.
2. **APIs & Services → Library:** enable the **Google Drive API**.
3. **APIs & Services → OAuth consent screen:**
   - Choose user type **Internal** if the Cloud project belongs to the same
     Workspace org you are restricting to. This is the simplest path.
     Otherwise choose **External**.
   - While unverified, External apps are capped at 100 **test users**. Add
     every address from `ALLOWED_EMAILS` there, and expect an "unverified app"
     warning plus refresh tokens that expire after 7 days.
   - Add the scopes `openid`, `email`, `profile`, and
     `https://www.googleapis.com/auth/drive`. Shared Drive support needs the
     full `drive` scope. Use `drive.file` instead only if you can live without
     Shared Drive buckets, since it is not a restricted scope and avoids the
     unverified-app limits above.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**,
   application type **Web application**. Add an authorized redirect URI:
   - Dev: `http://localhost:3000/auth/google/callback`
   - Prod: `https://<your-domain>/auth/google/callback`
5. Copy the **Client ID** and **Client secret** into `.env` as
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
6. Set `GOOGLE_WORKSPACE_DOMAIN` and/or `ALLOWED_EMAILS` per the table above,
   then point `GOOGLE_REDIRECT_URI` and `GOOGLE_DRIVE_SCOPE` at what you chose
   in steps 3 and 4.
7. Generate the two remaining secrets:

   ```bash
   openssl rand -base64 32   # MASTER_ENCRYPTION_KEY
   openssl rand -base64 48   # SESSION_SECRET
   ```

</details>

> [!WARNING]
> Opening this beyond a closed allowlist to unrestricted public sign-up is not
> recommended. The `drive` scope is a Google *restricted scope*, so serving it
> to the general public requires passing Google's formal app verification and
> an annual third-party security assessment (CASA).

## Optional: virtual-hosted endpoint

Path-style (`https://storage.example.com/my-bucket/key`) is the default and
always works. To also accept virtual-hosted requests
(`https://my-bucket.storage.example.com/key`), set:

```bash
S3_VIRTUAL_HOSTED_DOMAIN=storage.example.com
```

A request `Host` of `{bucket}.storage.example.com` then resolves the bucket
from the subdomain instead of the first path segment. Any other `Host`,
including the bare `storage.example.com`, keeps using path-style.

This needs a wildcard DNS record and a wildcard (or SAN) TLS certificate for
`*.storage.example.com` at your reverse proxy. Leave the variable unset to
disable virtual-hosted addressing entirely.

## Drive API quota

The **Quota** page answers "how much Google Drive API can this gateway still
use?" without guessing. It reports three things, kept separate because they
have different sources and different trustworthiness.

**Live request quota — from Google.** Drive API responses carry no rate-limit
headers, so the remaining request quota cannot be inferred from a Drive call.
It is read instead from the Google Cloud project that owns your OAuth client:
Service Usage supplies the configured limit, Cloud Monitoring supplies the
consumption, and remaining is the difference. Both numbers come from Google.
Where Monitoring reports nothing for a limit, the row reads *Unknown* rather
than showing an estimate.

This needs a read-only credential, separate from the user OAuth flow:

1. In the project that owns `GOOGLE_CLIENT_ID`, enable the **Service Usage
   API** and the **Cloud Monitoring API**.
2. Create a service account with the **Monitoring Viewer** and **Service Usage
   Consumer** roles. Both are read-only; neither can touch Drive data.
3. Set `GOOGLE_QUOTA_SERVICE_ACCOUNT_JSON` (raw or base64 JSON) or
   `GOOGLE_QUOTA_SERVICE_ACCOUNT_FILE` (an absolute path — the server's working
   directory is `apps/server`, so a relative one resolves there), then restart.

Cloud Monitoring additionally requires **billing enabled** on the project. Without
it the limits still read fine and the page shows them, but consumption and
remaining stay *Unknown* with the reason spelled out — the gateway never fills
that gap with an estimate. The observed counters below are unaffected.

Without it the page still works — it just says live quota is unconfigured
instead of inventing a remaining figure. Quota samples are cached for
`GOOGLE_QUOTA_CACHE_SECONDS` (default 60), because Cloud Monitoring only
publishes new numbers once a minute and enforces quotas of its own. Google
publishes those samples a few minutes late, so each row carries the timestamp
of the sample it came from.

**Observed usage — measured here.** Every HTTP call this gateway makes to
Google is counted as it happens, split by metadata/upload/download and
bucketed into 60s, 100s, 10m, 1h, and 24h windows. The 60s and 100s windows
match the two periods Google expresses Drive quotas in. Throttles are counted
separately from ordinary errors, and the last 50 rejections are listed with
the reason and `Retry-After` Google returned. These counters live in memory
only — bounded ring buffers, nothing written to the database — so they reset
on restart and cover this gateway's traffic alone. If anything else uses the
same Cloud project, they run lower than Google's own count.

**Storage quota — from Drive.** The one quota Google does report on a Drive
call (`about.get`): bytes used, remaining, and in trash for the signed-in
account.

The per-user breakdown is admin-only, since it shows how busy other people
have been. Everything else is visible to any signed-in user.

## Dashboard

Dashboard sections are plain paths (`/overview`, `/buckets`, `/buckets/:id`,
`/credentials`, `/activity`, `/documentation`, `/backup`, `/quota`,
`/security`, `/settings`) rather than query strings; `/mfa` is where sign-in
asks for the 2FA code. Those names are reserved (`util/dashboard-paths.ts`):
no bucket may take one, so a dashboard route can never collide with a real S3
bucket.

The **Documentation** page carries the connection steps for this gateway's own
endpoint and region, and an AI agent integration skill: a Markdown file, with
the endpoint and region filled in, to hand to an agent or a team integrating
another application.

### Object sharing

Owners and Editors can upload and delete objects; Viewers keep preview and
download access. Preview is limited to passive MIME types (PDF, text, raster
image, audio, and video). Active content such as HTML, SVG, XML, and
JavaScript is always downloaded instead.

Only a bucket Owner can create links:

- **Temporary presigned GET URLs** use an active S3 credential and expire in
  at most seven days. Rotating or revoking that credential invalidates them.
- **Persistent opaque URLs** stay active until their optional expiry or an
  explicit revoke. The token is returned once, and only its SHA-256 hash is
  stored.

Rotating a credential creates a new access-key pair and revokes the old pair in
one transaction. A credential can be permanently deleted only after revocation.

### Importing an existing Drive folder

Choose **Import from Drive** on the Objects page to copy a one-time snapshot
from a My Drive or Shared Drive folder. The folder hierarchy becomes the
relative object key. The source is always read-only: the gateway creates new
managed blobs, so deleting or overwriting through S3 never touches the
originals.

The import is deliberately conservative. Destination keys that already exist
and duplicate source names are skipped and reported. Empty folders have no S3
representation. Google Docs, Sheets, Slides, shortcuts, DriveS3-internal items,
files that cannot be downloaded, and keys over 1024 bytes are skipped too. The
job and its cursor live in SQLite, so it resumes after a restart, and
cancelling stops future work without rolling back files that already
succeeded.

## Quality gates

```bash
bun run typecheck
bun test
bun run build:web
bun scripts/verify-m4-runtime.ts
bun scripts/verify-m5-runtime.ts
bun scripts/verify-m6-runtime.ts
bun scripts/verify-m7-runtime.ts
```

External-client compatibility:

```bash
bash scripts/compat-aws-cli.sh
bash scripts/compat-rclone.sh
bash scripts/compat-mc.sh
```

Scripts print `SKIP` when a binary is unavailable. The AWS CLI, rclone, and
MinIO Client (`mc`) suites currently pass.

Load smoke:

```bash
bun run load:test -- --duration 5s --concurrency 16 \
  --scenarios put,get,list,multipart
```

See the [performance guidance](docs/PERFORMANCE.md).

## Production deployment

The gateway is one Bun process on `127.0.0.1:8787` behind a reverse proxy that
terminates HTTPS. Run it with **Docker Compose** or with **PM2**: one or the
other, never both against the same data. This is the path from an empty server
to a running, backed-up gateway; the [deployment guide](docs/DEPLOY.md) holds
the full environment reference and proxy notes.

### 1. Prepare the server and domain

- A Linux host with persistent local disk (not NFS), and either Docker with the
  Compose plugin, or Bun, PM2, and curl.
- A DNS record pointing your domain (below: `s3.example.com`) at the host.
- A reverse proxy for HTTPS. Caddy obtains certificates by itself:

  ```caddyfile
  s3.example.com {
      reverse_proxy 127.0.0.1:8787
  }
  ```

  Caddy keeps the `Host` header (SigV4 signs it), passes `Authorization` and
  `x-amz-*` through, sets `X-Forwarded-For`/`-Proto`, and streams request
  bodies. With nginx or Traefik, check the same points in
  [DEPLOY.md §5](docs/DEPLOY.md#5-reverse-proxy-notes).

### 2. Register the production OAuth redirect

In your Google Cloud OAuth client ([Google OAuth setup](#google-oauth-setup)),
add the authorized redirect URI `https://s3.example.com/auth/google/callback`.
An External, unverified consent screen also needs every allowed address added
as a test user.

### 3. Get the code and write `.env`

```bash
git clone <repository-url> /srv/drives3
cd /srv/drives3
bash scripts/deploy.sh --domain s3.example.com
```

With no `.env` yet, the deploy script writes one from `.env.example` and stops:
fresh `MASTER_ENCRYPTION_KEY` and `SESSION_SECRET`, and from `--domain` the
public addresses, `S3_REQUIRE_TLS`, and `TRUST_PROXY`. To write it by hand
instead, `cp .env.example .env` and generate the two secrets with
`openssl rand -base64 32` and `openssl rand -base64 48`.

Set at least:

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` |
| `APP_ORIGIN` | `https://s3.example.com` |
| `GOOGLE_REDIRECT_URI` | `https://s3.example.com/auth/google/callback` |
| `S3_PUBLIC_ENDPOINT` | `https://s3.example.com` |
| `S3_REQUIRE_TLS` | `true` |
| `TRUST_PROXY` | `true` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from the OAuth client |
| `GOOGLE_WORKSPACE_DOMAIN` and/or `ALLOWED_EMAILS` | who may sign in; at least one |
| `ADMIN_EMAILS` | who may open Settings (optional) |
| `MASTER_ENCRYPTION_KEY`, `SESSION_SECRET` | the two values generated above |
| `BACKUP_PASSPHRASE` | the recovery passphrase, for scheduled backups (step 7) |

Leave `SQLITE_PATH`, `SERVER_PORT`, and `STATIC_ROOT` alone; Compose and the
PM2 script set what they need. The server refuses to start in production with
an `http://` origin, `S3_REQUIRE_TLS=false`, or a secret of the wrong length.

### 4. Keep the master key and a recovery passphrase off the server

Copy `MASTER_ENCRYPTION_KEY` into a password manager now. It seals every OAuth
token, S3 secret key, 2FA secret, and KMS key in the database, and no other key
can read them later. Pick a **recovery passphrase** as well — at least 12
characters; a sentence of unrelated words works well — and store it the same
way. A backup made with it can be restored, and the master key recovered, with
the passphrase alone (step 9).

### 5. Start the gateway

```bash
bash scripts/deploy.sh          # Docker Compose, when Docker is installed
bash scripts/deploy.sh --pm2    # or PM2, as the non-root user that will own the service
```

It checks `.env`, builds, starts the gateway on `127.0.0.1:8787`, and waits for
`/health/ready`, printing the logs if it never gets there. Under Compose it
also hands `./data` to uid 1010: the container runs as that user and must own
the bind mount. Under PM2, run `pm2 startup` once per host (and the command it
prints) so the gateway survives a reboot.

<details>
<summary><b>The same by hand</b></summary>

**Docker Compose:**

```bash
mkdir -p data
sudo chown -R 1010:1010 data    # the container runs as uid 1010 and must own the bind mount
docker compose up -d --build
docker compose logs -f gateway  # wait for "migrations applied" and "server listening"
```

**PM2:**

```bash
bash scripts/deploy-pm2.sh
pm2 startup                     # once per host: run the command it prints, then
pm2 save
```

</details>

### 6. Verify

```bash
curl --fail https://s3.example.com/health/ready
```

Sign in at `https://s3.example.com`, create a bucket and an access key, then
point an S3 client at it:

```bash
aws configure --profile drives3   # the access key, its secret, region us-east-1
aws --profile drives3 --endpoint-url https://s3.example.com s3 ls
```

### 7. Back up, with key recovery

Take the first backup by hand; it asks for the recovery passphrase twice:

```bash
# Docker Compose: the backup tools ship in the image
docker compose exec gateway bun dist/scripts/backup-sqlite.js --out /app/data/backups

# PM2: run from the checkout, which reads MASTER_ENCRYPTION_KEY from .env
bun run db:backup -- --out ./backups
```

Then schedule it, hourly for a busy gateway and at least daily otherwise. With
`BACKUP_PASSPHRASE` in `.env` it runs unattended — under Compose, run
`docker compose up -d` after editing `.env` so the container sees the variable:

```cron
# Docker Compose
0 * * * * cd /srv/drives3 && docker compose exec -T gateway bun dist/scripts/backup-sqlite.js --out /app/data/backups
# PM2 (cron has no ~/.bun/bin on its PATH)
0 * * * * cd /srv/drives3 && $HOME/.bun/bin/bun run db:backup -- --out ./backups
```

Copy the archives off the host — another machine or object storage. A backup
that lives only on the server it protects is lost with that server. Under
Compose they land in `data/backups/`, owned by uid 1010.

Or let the gateway do both for you: **Settings → Scheduled database snapshots**
takes the same archive on a schedule and ships it to one of the admin's backup
destinations (S3, rclone or Drive), keeping the newest N. No host cron, nothing
to copy by hand; see
[the runbook](docs/OPERATIONS.md#11-scheduled-database-snapshots).

### 8. Upgrade

```bash
bash scripts/redeploy.sh
```

It fetches and fast-forwards the checkout, builds the new image while the
running one keeps serving (Compose), backs the database up, restarts, and
waits for `/health/ready`; pending migrations run at startup. If the new
version never gets ready, it puts the previous code and image back and starts
them again. The database stays as the new version migrated it — migrations
only add, so the old code runs on it — and the script prints the backup it took
with the command to restore it. `--ref v1.2.3` deploys a tag or commit instead
of the branch's upstream; `--help` lists the other options. Rolling back by
hand is covered in [DEPLOY.md §8](docs/DEPLOY.md#8-rollback).

### 9. Rebuild on a new server that lost the master key

1. Do steps 1–3 on the new host, but leave `MASTER_ENCRYPTION_KEY` empty.
2. Put the latest archive and its `.manifest.json` on the host. Under Compose:

   ```bash
   mkdir -p data/backups && cp drives3-<timestamp>.sqlite.gz.enc* data/backups/
   sudo chown -R 1010:1010 data
   docker compose build
   ```

3. Restore. It asks for the recovery passphrase and prints the master key:

   ```bash
   # Docker Compose
   docker compose run --rm gateway bun dist/scripts/restore-sqlite.js \
     --input /app/data/backups/drives3-<timestamp>.sqlite.gz.enc
   # PM2
   bun run db:restore -- --input ./backups/drives3-<timestamp>.sqlite.gz.enc
   ```

   If `.env` already holds a newly generated key, the restore says that key
   does not open the archive; add `--passphrase`. If the gateway was started
   once already, an empty database exists at the target; add `--force`.
4. Put the printed key into `.env` as `MASTER_ENCRYPTION_KEY`, then start the
   gateway (step 5). Users sign in as before; their tokens, access keys, and 2FA
   come back with the database.

An archive made without a recovery passphrase can only be restored with the
original key.

## Architecture constraints

- Run one application process per local SQLite database.
- Keep SQLite and multipart temp data on local persistent storage, never NFS.
- Do not delete `MULTIPART_TEMP_DIR` during normal restart or recovery.
- Terminate production TLS at a reverse proxy and preserve SigV4 headers.
- Never log or commit OAuth tokens, S3 secret keys, session cookies, or
  `MASTER_ENCRYPTION_KEY`.

## Further reading

| Document | Covers |
|---|---|
| [Deployment guide](docs/DEPLOY.md) | Docker and PM2 setup, environment reference, reverse proxy notes, upgrade and rollback. |
| [Operations runbook](docs/OPERATIONS.md) | Restart safety, backup and restore, key handling, failure triage, backup destinations, scheduled backups, and database snapshots. |
| [Performance guidance](docs/PERFORMANCE.md) | Load-test harness and tuning notes. |
