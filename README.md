# DriveS3 Gateway

![Runtime](https://img.shields.io/badge/runtime-Bun-000000)
![Language](https://img.shields.io/badge/language-TypeScript-3178C6)
![Frontend](https://img.shields.io/badge/frontend-React%2018-61DAFB)
![Storage](https://img.shields.io/badge/storage-SQLite-003B57)

A multi-user, Google-Drive-backed, S3-compatible storage gateway. Point any
S3 client — the AWS SDK, AWS CLI, rclone, MinIO `mc` — at your own domain,
and objects are stored as real files in Google Drive, with SQLite as the
source of truth for the S3 namespace.

Buckets live in the owner's **My Drive** or in an explicitly selected Google
**Shared Drive**. Shared Drive access is granted per user (Viewer/Editor);
every user acts through their own Google OAuth grant — there is no
service-account backdoor into anyone's Drive.

## Contents

- [Features](#features)
- [Compatibility](#compatibility)
- [Quick start](#quick-start)
- [Google OAuth setup](#google-oauth-setup)
- [Virtual-hosted-style endpoint (optional)](#virtual-hosted-style-endpoint-optional)
- [Dashboard](#dashboard)
- [Quality gates](#quality-gates)
- [Production deployment](#production-deployment)
- [Backup and restore](#backup-and-restore)
- [Architecture constraints](#architecture-constraints)
- [Further reading](#further-reading)

## Features

**Auth & security**
- Google OAuth login gated by Workspace domain and/or an explicit email
  allowlist (personal Gmail included), with encrypted refresh tokens.
- Session/CSRF protection, SigV4 header and presigned-query authentication.
- Security headers, bounded control/XML request bodies, and rate limiting.

**S3 data plane**
- Path-style CRUD, `ListObjectsV2`, bulk delete, byte-range GET, conditional
  GET (`If-Match` / `If-None-Match` / `If-Modified-Since`).
- Multipart upload lifecycle and `CopyObject`.
- Optional virtual-hosted-style addressing (`{bucket}.{domain}`) alongside
  the always-on path-style default.
- Streaming/resumable uploads, atomic overwrite, cleanup queue and
  reconciliation against Drive.

**Dashboard**
- Bucket and object control plane: streaming upload, preview, download,
  delete, temporary presigned links, and revocable public links.
- S3 credential lifecycle: create, atomic rotate, revoke, revoked-only
  permanent delete.
- One-time import of an existing Google Drive folder tree into a bucket.
- Traffic charts (bandwidth, request count, error count) over 1h/24h/7d
  windows, auto-refreshing every 15s — a dashboard-wide overview summed
  across every accessible bucket, and a per-bucket detail view.

**Operations**
- Encrypted backup/restore, a load-test harness, and a Docker image.

## Compatibility

This is **not** a complete Amazon S3 implementation, and the dashboard ships
an evidence-based compatibility matrix — every "supported" row is backed by
a passing test, nothing is marked supported on faith. Broad strokes:

| Supported | Not supported |
|---|---|
| Path-style (default) and virtual-hosted-style (opt-in) endpoints | Object versioning |
| Core object CRUD, `ListObjectsV2`, byte-range/conditional GET | Object Lock / Legal Hold |
| Multipart upload, `CopyObject` (same actor) | ACL & bucket policy |
| SigV4 header and presigned-query auth | SigV4A, PresignedPost (form) |
| AWS CLI, rclone, MinIO `mc` compatibility smokes | SSE-KMS / server-side encryption |
| | Cross-user `CopyObject` across unrelated My Drive accounts |

Open the dashboard's Overview page for the full, live matrix with the test
evidence behind each row.

## Quick start

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun install
cp .env.example .env
# Fill GOOGLE_* plus MASTER_ENCRYPTION_KEY and SESSION_SECRET — see
# "Google OAuth setup" below.
bun run dev
```

The web app runs through Vite on port 5173 and proxies control-plane routes
to the Bun server on port 3000. The dashboard uses a responsive
shadcn/Tailwind component system with persisted light and dark themes.
Bucket owners can create short-lived SigV4 links or opaque public links;
opaque link tokens are shown once, stored only as hashes, and can be revoked
independently of S3 access keys.

## Google OAuth setup

Login is allowed through either (or both) of two independent gates — at
least one must be configured:

- `GOOGLE_WORKSPACE_DOMAIN` — any account whose OAuth `hd` claim matches this
  domain (i.e. any member of that **Google Workspace** org).
- `ALLOWED_EMAILS` — a comma-separated allowlist of specific email addresses,
  including plain consumer **Gmail** accounts, which have no `hd` claim and
  so cannot satisfy the domain check.

1. In [Google Cloud Console](https://console.cloud.google.com/), create or
   select a project.
2. **APIs & Services → Library**: enable the **Google Drive API**.
3. **APIs & Services → OAuth consent screen**:
   - User type **Internal** if the Cloud project belongs to the same
     Workspace org you're restricting to (simplest); otherwise **External**.
     While unverified, External apps are capped at 100 **test users** — add
     every email from your `ALLOWED_EMAILS` list there, and expect an
     "unverified app" warning plus refresh tokens that expire after 7 days.
   - Add scopes `openid`, `email`, `profile`, and
     `https://www.googleapis.com/auth/drive` (Shared Drive support needs the
     full `drive` scope; use `drive.file` instead only if you don't need
     Shared Drive buckets — `drive.file` is not a restricted scope, so it
     avoids the unverified-app limits above).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**,
   application type **Web application**. Add an authorized redirect URI:
   - Dev: `http://localhost:3000/auth/google/callback`
   - Prod: `https://<your-domain>/auth/google/callback`
5. Copy the generated **Client ID** and **Client secret** into `.env` as
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
6. Set `GOOGLE_WORKSPACE_DOMAIN` and/or `ALLOWED_EMAILS` per the gates above,
   and `GOOGLE_REDIRECT_URI` / `GOOGLE_DRIVE_SCOPE` to match steps 3–4.
7. Generate the two remaining secrets and put them in `.env` too:
   ```bash
   openssl rand -base64 32   # MASTER_ENCRYPTION_KEY
   openssl rand -base64 48   # SESSION_SECRET
   ```

Opening this up beyond a closed allowlist to unrestricted public sign-up is
not recommended: the `drive` scope is a Google *restricted scope*, so serving
it to the general public requires passing Google's formal app verification
and an annual third-party security assessment (CASA).

## Virtual-hosted-style endpoint (optional)

Path-style (`https://storage.example.com/my-bucket/key`) is the default and
always works. To also accept virtual-hosted-style requests
(`https://my-bucket.storage.example.com/key`), set:

```bash
S3_VIRTUAL_HOSTED_DOMAIN=storage.example.com
```

A request `Host` of `{bucket}.storage.example.com` then resolves the bucket
from the subdomain instead of the first path segment; any other `Host`
(including the bare `storage.example.com` itself) keeps using path-style.
This needs a wildcard DNS record and a wildcard (or SAN) TLS certificate for
`*.storage.example.com` at your reverse proxy. Leave the variable unset to
disable virtual-hosted addressing entirely.

## Dashboard

Dashboard sections are plain paths — `/buckets`, `/buckets/:id`,
`/credentials`, `/activity`, `/documentation` — not query strings. Those five
names are reserved: `util/bucket-name.ts` rejects them as bucket names, so a
dashboard route can never collide with a real S3 bucket.

### Object sharing

Bucket Owners and Editors can upload and delete objects from the Objects
page; Viewers retain preview and download access. Preview is limited to
passive MIME types (PDF, text, raster image, audio, and video); active
content such as HTML, SVG, XML, and JavaScript is always downloaded instead.

Only a bucket Owner can create links:

- Temporary presigned GET URLs use an active S3 credential and expire in at
  most seven days. Rotating or revoking that credential invalidates the URL.
- Persistent opaque URLs remain active until their optional expiry or
  explicit revoke. The token is returned once and only its SHA-256 hash is
  stored.

Rotating a credential creates a new access-key pair and revokes the old pair
in one transaction. A credential can be permanently deleted only after
revocation.

### Importing an existing Drive folder

Bucket owners can choose **Import from Drive** on the Objects page to copy a
one-time snapshot from a My Drive or Shared Drive folder. The folder
hierarchy becomes the relative object key. The source is always read-only —
the gateway creates new managed blobs, so deleting or overwriting through S3
never touches the original files.

The import is conservative: destination keys that already exist and
duplicate source names are skipped and reported. Empty folders have no S3
representation. Google Docs/Sheets/Slides, shortcuts, DriveS3-internal items,
files that can't be downloaded, and keys over 1024 bytes are also skipped.
The job and its cursor are persisted in SQLite, so the process can resume
after a restart; cancelling stops future work without rolling back files
that already succeeded.

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

Scripts print `SKIP` when a binary is unavailable. AWS CLI, rclone, and MinIO
Client (`mc`) compatibility smokes currently pass.

Load smoke:

```bash
bun run load:test -- --duration 5s --concurrency 16 \
  --scenarios put,get,list,multipart
```

See [performance guidance](docs/PERFORMANCE.md).

## Production deployment

Docker Compose:

```bash
cp .env.example .env
# Fill all production values; APP_ORIGIN/S3_PUBLIC_ENDPOINT must be https://.
docker compose up -d --build
```

The container runs as a non-root user, stores SQLite/multipart data on
`./data:/app/data`, and listens on `127.0.0.1:8787` for a TLS reverse proxy.

Direct host deployment with PM2 is also available when Bun, PM2, and curl are
installed:

```bash
bash scripts/deploy-pm2.sh
pm2 status
curl --fail http://127.0.0.1:8787/health/ready
```

Docker and PM2 are alternative deployment methods. Do not run both against
the same port or SQLite database. Read [deployment](docs/DEPLOY.md) before
production use.

## Backup and restore

```bash
export MASTER_ENCRYPTION_KEY='<base64 32-byte key>'
bun run db:backup -- --source ./data/app.sqlite --out ./backups
bun run db:restore -- --input ./backups/<archive>.sqlite.gz.enc \
  --target ./data/restored.sqlite
```

Backups are gzip-compressed and AES-256-GCM encrypted, with integrity
manifests. See the [operations runbook](docs/OPERATIONS.md) for restart
safety, restore, key handling, multipart temp storage, and failure triage.

## Architecture constraints

- Run one application process per local SQLite database.
- Keep SQLite and multipart temp data on local persistent storage, not NFS.
- Do not delete `MULTIPART_TEMP_DIR` during normal restart/recovery.
- Terminate production TLS at a reverse proxy and preserve SigV4 headers.
- Never log or commit OAuth tokens, S3 secret keys, session cookies, or
  `MASTER_ENCRYPTION_KEY`.

## Further reading

- [Deployment guide](docs/DEPLOY.md) — Docker/PM2 setup, environment
  reference, reverse proxy notes, upgrade and rollback procedures.
- [Operations runbook](docs/OPERATIONS.md) — restart safety, backup/restore,
  key handling, failure triage.
- [Performance guidance](docs/PERFORMANCE.md) — load-test harness and
  tuning notes.
