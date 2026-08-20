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
Versioning, Object Lock, ACL/policies, virtual-hosted buckets, SigV4A, SSE-KMS,
and cross-user copies are intentionally unsupported.

## Development

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun install
cp .env.example .env
# Fill GOOGLE_* plus MASTER_ENCRYPTION_KEY and SESSION_SECRET.
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
