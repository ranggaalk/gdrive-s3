# Production deployment

DriveS3 Gateway ships as a single Bun process serving:

- `/health/*` — probes;
- `/auth/*` — Google OAuth callbacks;
- `/api/*` — dashboard control plane;
- `/`, `/index.html`, `/favicon.ico`, `/__drives3_assets/*` — the built dashboard
  (`STATIC_ROOT`);
- `/overview`, `/buckets`, `/buckets/:bucketId`, `/credentials`, `/activity`,
  `/documentation` — client-side dashboard section routes, also served as the
  same `index.html` shell;
- `/__drives3_share/:token` — rate-limited anonymous public object downloads;
- everything else — the S3 path-style data plane.

The reserved `__drives3_assets/` prefix is invalid as an S3 bucket name (underscore),
so dashboard assets cannot collide with `/{bucket}/{key}` routes. The dashboard
section names above (`overview`, `buckets`, `credentials`, `activity`,
`documentation`) are likewise rejected as bucket names by
`util/bucket-name.ts`, so they can never collide with a real bucket either.
Authenticated SigV4 requests never receive dashboard responses; the router
falls through to the S3 handler as soon as an `Authorization` or `X-Amz-*`
header/query is present.

## 1. Requirements

- Reverse proxy (Caddy, nginx, Traefik) providing HTTPS and forwarding to the
  gateway on `127.0.0.1:8787`.
- Persistent volume for `data/` (SQLite + multipart).
- Google OAuth client with an authorized redirect URI equal to
  `APP_ORIGIN + /auth/google/callback`. Restrict who can log in via
  `GOOGLE_WORKSPACE_DOMAIN` (a Workspace org), `ALLOWED_EMAILS` (a specific
  allowlist, including personal Gmail accounts), or both — see
  [README](../README.md#google-oauth-setup).
- Base64-encoded 32-byte `MASTER_ENCRYPTION_KEY` and `SESSION_SECRET`
  (`openssl rand -base64 32`).

## 2. Build and run with Docker

```bash
docker build -t drives3-gateway:local .
cp .env.example .env      # fill in Google client id/secret and the two secrets
docker compose up -d
```

The image is a multi-stage Bun build. Runtime characteristics:

- non-root user (`drives3`, uid/gid 1010) owns `/app/data`;
- SQLite lives at `/app/data/app.sqlite`, multipart parts at
  `/app/data/multipart`;
- migrations are copied to `/app/dist/server/migrations`; `MIGRATIONS_DIR`
  points there and is resolved by the bundled server via
  `apps/server/src/db/migrate.ts`;
- the Compose healthcheck calls `http://127.0.0.1:8787/health/ready`;
- `security_opt: no-new-privileges` and `cap_drop: ALL` are applied.

The Compose service binds only to `127.0.0.1:8787`; expose it through the HTTPS
reverse proxy rather than binding the gateway directly to a public interface.

## 3. Deploy directly with PM2

Use this as an alternative to Docker when Bun, PM2, and curl are installed on
the production host. Configure `.env` first, then run the script as the same
non-root service user on every deployment:

```bash
bash scripts/deploy-pm2.sh
pm2 describe drives3-gateway
curl --fail http://127.0.0.1:8787/health/ready
```

The script installs the locked dependencies, builds the dashboard and server,
copies SQL migrations into `dist/server/migrations`, and starts
`drives3-gateway` on `127.0.0.1:8787`. Server startup applies pending migrations
before binding the socket. The script waits for `/health/ready` and runs
`pm2 save` only after the probe succeeds.

PM2 runs exactly one fork process. Do not use cluster mode, multiple instances,
watch mode, or `pm2 reload`: overlapping processes must not share the same
SQLite database. A deployment replaces the previous process after the new build
has completed, allowing the server's `SIGTERM` handler to stop workers and
checkpoint SQLite.

Configure PM2 startup once during host provisioning, using the command emitted
for the service user's init system:

```bash
pm2 startup
pm2 save
```

Do not run Docker and PM2 simultaneously against the same port or data paths.
Keep SQLite and multipart storage on local persistent storage and take a fresh
backup before upgrades.

## 4. Environment

Required (see `.env.example`):

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`;
- at least one of `GOOGLE_WORKSPACE_DOMAIN` or `ALLOWED_EMAILS` (startup
  refuses to boot with neither set);
- `MASTER_ENCRYPTION_KEY`, `SESSION_SECRET`;
- production defaults: `NODE_ENV=production`, `S3_REQUIRE_TLS=true`,
  `APP_ORIGIN=https://…`, `TRUST_PROXY=true` when behind a proxy.

Optional: `ADMIN_EMAILS` (comma-separated) grants the dashboard's Settings
page, where `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` can be overridden at
runtime (stored encrypted in SQLite, no restart needed). Empty by default —
nobody can reach it until set.

Recommended production overrides:

- `S3_PUBLIC_ENDPOINT=https://<your-domain>` to make presigned URLs return the
  public URL clients should call.
- `S3_VIRTUAL_HOSTED_DOMAIN=<your-domain>` to also accept virtual-hosted-style
  requests (`{bucket}.<your-domain>`) alongside path-style, which stays the
  default regardless. Requires a wildcard DNS record and wildcard/SAN TLS
  certificate for `*.<your-domain>` at the reverse proxy — see
  [README](../README.md#virtual-hosted-style-endpoint-optional).
- Set `RATE_LIMIT_*` thresholds appropriate to your workload.

The gateway refuses to start if any of these hold: `NODE_ENV=production` and
`S3_REQUIRE_TLS=false`, `APP_ORIGIN` is `http://`, or any secret is not the
required length. Fix the environment before restarting; do not lower the
requirements.

## 5. Reverse proxy notes

- Terminate TLS at the proxy. Send:
  - `X-Forwarded-For` (client IP);
  - `X-Forwarded-Proto: https`.
- Preserve S3 authentication headers (`Authorization`, `x-amz-*`). Do not
  buffer request bodies larger than the object size limits you allow.
- Ensure the proxy does not add `Origin` or CORS headers for the S3 plane.
- Preserve Range requests for `/__drives3_share/*`, but redact the token-bearing
  path from proxy access/error logs. The application masks it as
  `/__drives3_share/:token`; proxy logs must do the same.
- Apply a stricter edge rate limit to public share routes in addition to
  `RATE_LIMIT_PUBLIC_SHARE_RPS_PER_IP`.
- If TLS terminates at the proxy, set `TRUST_PROXY=true`.

## 6. Backups

Follow [OPERATIONS.md](OPERATIONS.md). Run backup scripts on the host (they use
Bun and read `MASTER_ENCRYPTION_KEY` from the environment), or `docker exec`
into the running container. Retain encrypted archives off-host.

## 7. Upgrade procedure

1. Take a fresh backup (`bun run db:backup`).
2. Pull or build the new image.
3. `docker compose up -d`; watch startup logs for successful `migrations
   applied`.
4. Verify `/health/ready`, dashboard, one S3 PUT/GET/DELETE, and pending
   cleanup backlog.
5. Keep the previous image tag until the release is confirmed stable.

## 8. Rollback

1. Stop the container.
2. Restore the pre-upgrade backup (`bun run db:restore`).
3. Redeploy the previous image tag.
4. Start and re-verify.

## 9. Observability

The server logs JSON on stdout with a redaction list. Send logs to a central
sink and alert on:

- `INTERNAL_ERROR` responses;
- `SlowDown`/`ServiceUnavailable` spikes;
- backup failures;
- `pending_cleanup` backlog above a threshold.
