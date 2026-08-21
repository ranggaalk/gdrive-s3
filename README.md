# DriveS3 Gateway

A multi-user, Google-Drive-backed, path-style S3-compatible gateway built with
Bun, TypeScript, SQLite, React 18, shadcn/ui, and Tailwind CSS.

Buckets can store bytes in the owner's **My Drive** or an explicitly selected
Google Shared Drive. SQLite remains the source of truth for S3 namespace
metadata and maps `bucket/key` to stable Drive file IDs. Shared Drive S3 access
is granted only to selected DriveS3 users (Viewer/Editor), and each user operates
with their own Google OAuth grant; service-account ownership is not used.

## Implemented surface

- Google OAuth with Workspace-domain restriction and encrypted refresh tokens.
- Session/CSRF protection and S3 credential lifecycle.
- Bucket and object control-plane dashboard with streaming upload, preview,
  download, delete, temporary presigned links, and revocable public links.
- S3 credential create, atomic rotate, revoke, and revoked-only permanent delete.
- S3 path-style CRUD, ListObjectsV2, bulk delete, byte ranges, conditional GET.
- SigV4 header and presigned query authentication.
- Streaming/resumable uploads, atomic overwrite, cleanup queue, reconciliation.
- Owner-triggered one-time import of pre-existing Google Drive folder trees.
- Multipart upload lifecycle and CopyObject.
- M7 hardening: security headers, bounded control/XML bodies, rate limiting,
  failure-injection tests, encrypted backup/restore, load harness, and Docker.

This is **not** a complete Amazon S3 implementation. The dashboard's evidence-
based compatibility matrix marks features as supported, untested, or unsupported.
Versioning, Object Lock, ACL/policies, SigV4A, SSE-KMS, and cross-user copies
across unrelated My Drive accounts are intentionally unsupported. Virtual-hosted-
style bucket endpoints (`{bucket}.{domain}`) are supported as an opt-in — see
`S3_VIRTUAL_HOSTED_DOMAIN` below; path-style stays the default.

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

## Development

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun install
cp .env.example .env
# Fill GOOGLE_* plus MASTER_ENCRYPTION_KEY and SESSION_SECRET — see
# "Google OAuth setup" above.
bun run dev
```

The web app runs through Vite on port 5173 and proxies control-plane routes to
the Bun server on port 3000. The dashboard uses a responsive shadcn/Tailwind
component system with persisted light and dark themes. Bucket owners can create
short-lived SigV4 links or opaque public links; opaque link tokens are shown once,
stored only as hashes, and can be revoked independently of S3 access keys.

## Quality gates

```bash
bun run typecheck
bun test
bun run build:web
bun scripts/verify-m4-runtime.ts
bun scripts/verify-m5-runtime.ts
bun scripts/verify-m6-runtime.ts
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

Docker and PM2 are alternative deployment methods. Do not run both against the
same port or SQLite database. Read [deployment](docs/DEPLOY.md) before production
use.

## Backup and restore

```bash
export MASTER_ENCRYPTION_KEY='<base64 32-byte key>'
bun run db:backup -- --source ./data/app.sqlite --out ./backups
bun run db:restore -- --input ./backups/<archive>.sqlite.gz.enc \
  --target ./data/restored.sqlite
```

Backups are gzip-compressed and AES-256-GCM encrypted, with integrity manifests.
See the [operations runbook](docs/OPERATIONS.md) for restart safety, restore,
key handling, multipart temp storage, and failure triage.

## Dashboard object sharing

Bucket Owners and Editors can upload and delete objects from the Objects page;
Viewers retain preview and download access. Preview is limited to passive MIME
types (PDF, text, raster image, audio, and video); active content such as HTML,
SVG, XML, and JavaScript is always downloaded instead.

Only a bucket Owner can create links:

- Temporary presigned GET URLs use an active S3 credential and expire in at most
  seven days. Rotating or revoking that credential invalidates the URL.
- Persistent opaque URLs remain active until their optional expiry or explicit
  revoke. The token is returned once and only its SHA-256 hash is stored.

Rotating a credential creates a new access-key pair and revokes the old pair in
one transaction. A credential can be permanently deleted only after revocation.

## Import data Drive yang sudah ada

Pemilik bucket dapat memilih **Import dari Drive** pada halaman Objects untuk
menyalin snapshot satu kali dari folder My Drive atau Shared Drive. Hierarki
folder menjadi object key relatif. Source selalu read-only; gateway membuat blob
terkelola baru agar delete/overwrite S3 tidak mengubah file asli.

Import bersifat konservatif: key tujuan yang sudah ada dan nama sumber duplikat
dilewati serta masuk laporan. Empty folder tidak direpresentasikan oleh S3.
Google Docs/Sheets/Slides, shortcut, item internal DriveS3, file yang tidak dapat
di-download, dan key di atas 1024 byte juga dilewati. Job dan cursor disimpan di
SQLite sehingga proses dapat dilanjutkan setelah restart; cancel menghentikan
pekerjaan berikutnya tanpa rollback file yang sudah berhasil.

## Architecture constraints

- Run one application process per local SQLite database.
- Keep SQLite and multipart temp data on local persistent storage, not NFS.
- Do not delete `MULTIPART_TEMP_DIR` during normal restart/recovery.
- Terminate production TLS at a reverse proxy and preserve SigV4 headers.
- Never log or commit OAuth tokens, S3 secret keys, session cookies, or
  `MASTER_ENCRYPTION_KEY`.
