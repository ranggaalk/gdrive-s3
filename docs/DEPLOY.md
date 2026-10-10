# Production deployment

DriveS3 Gateway ships as a single Bun process serving:

- `/health/*` — probes;
- `/auth/*` — Google OAuth callbacks;
- `/api/*` — dashboard control plane;
- `/`, `/index.html`, `/favicon.ico`, `/__drives3_assets/*` — the built dashboard
  (`STATIC_ROOT`);
- `/overview`, `/buckets`, `/buckets/:bucketId`, `/credentials`, `/activity`,
  `/documentation`, `/backup`, `/quota`, `/security`, `/settings` — client-side
  dashboard section routes, also served as the same `index.html` shell;
- `/mfa` — where sign-in sends a session that still needs its 2FA code, also
  the `index.html` shell;
- `/__drives3_share/:token` — rate-limited anonymous public object downloads;
- everything else — the S3 path-style data plane.

The reserved `__drives3_assets/` prefix is invalid as an S3 bucket name (underscore),
so dashboard assets cannot collide with `/{bucket}/{key}` routes. The dashboard
section names above (`overview`, `buckets`, `credentials`, `activity`,
`documentation`, `backup`, `quota`, `security`, `settings`, and `mfa`) are
likewise rejected as bucket names; `util/dashboard-paths.ts` lists them for
both, so they can never collide with a real bucket either.
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
bash scripts/deploy.sh    # Compose is the default wherever Docker is installed
```

`scripts/deploy.sh` checks `.env` (writing one from `.env.example` with fresh
secrets if there is none, then stopping so the rest can be filled in), builds
the image, hands `./data` to uid 1010, starts the service, and waits for
`/health/ready`, printing the container's logs if it never gets there. By hand:

```bash
docker build -t drives3-gateway:local .
cp .env.example .env      # fill in Google client id/secret and the two secrets
mkdir -p data && sudo chown -R 1010:1010 data
docker compose up -d
```

`./data` is a bind mount, so it keeps the host directory's ownership rather
than the image's. Docker creates a missing one as root, and the non-root
gateway then cannot create its database; hand it to uid 1010 first.

The image is a multi-stage Bun build. Runtime characteristics:

- non-root user (`drives3`, uid/gid 1010) owns `/app/data`;
- SQLite lives at `/app/data/app.sqlite`, multipart parts at
  `/app/data/multipart`;
- migrations are copied to `/app/dist/server/migrations`; `MIGRATIONS_DIR`
  points there and is resolved by the bundled server via
  `apps/server/src/db/migrate.ts`;
- the SQLite backup and restore tools are bundled at `dist/scripts/` (see §6);
- the Compose healthcheck calls `http://127.0.0.1:8787/health/ready`;
- `security_opt: no-new-privileges` and `cap_drop: ALL` are applied.

The Compose service binds only to `127.0.0.1:8787`; expose it through the HTTPS
reverse proxy rather than binding the gateway directly to a public interface.

## 3. Deploy directly with PM2

Use this as an alternative to Docker when Bun, PM2, and curl are installed on
the production host. Configure `.env` first, then deploy as the same non-root
service user every time:

```bash
bash scripts/deploy.sh --pm2    # checks .env, then runs scripts/deploy-pm2.sh
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

Backup destinations beyond Drive: S3-compatible destinations need no
configuration. rclone destinations need `INSTALL_RCLONE=true` at image build
time, an `rclone.conf`, and `BACKUP_RCLONE_REMOTES`; see
[OPERATIONS](OPERATIONS.md#9-backup-destinations-s3-and-rclone).

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

Follow [OPERATIONS.md](OPERATIONS.md). Under PM2, run `bun run db:backup` from
the checkout. Under Docker the image holds no source tree, so the tools are
bundled into it instead; run them inside the container, as its own user and
with its environment:

```bash
docker compose exec gateway bun dist/scripts/backup-sqlite.js --out /app/data/backups
```

Do not run the checkout's scripts on the host against `./data`: the host user
does not own it, and running them as root can leave SQLite's `-shm` file
root-owned, which locks the gateway out of its own database.

Retain encrypted archives off-host. Make them with a recovery passphrase
(`BACKUP_PASSPHRASE` for scheduled jobs) so a host rebuilt without the master
key can still restore — see OPERATIONS.md §3.1 and the README's
[step-by-step guide](../README.md#production-deployment).

## 7. Upgrade procedure

`bash scripts/redeploy.sh` runs steps 1 to 3 below, for Compose and PM2 alike:

1. It fetches and fast-forwards the checkout to its branch's upstream, or
   checks out `--ref <tag-or-commit>`. Local changes to tracked files, or a
   branch that has diverged from its upstream, stop it before anything else.
2. Under Compose it builds the new image while the running container keeps
   serving, and keeps the running one as `drives3-gateway:previous`. A failed
   build stops here, with nothing restarted.
3. It backs the database up (§6) — into `./data/backups` under Compose,
   `./backups` under PM2 — then restarts on the new version and waits for
   `/health/ready`. Set `BACKUP_PASSPHRASE` so that unattended backup carries
   key recovery; `--no-backup` skips it.

If the new version never becomes ready, the script goes back on its own: the
previous checkout and image, started again. It leaves the database as the new
version migrated it, since migrations only add and the old code runs on the
result; to take the data back as well, follow §8 with the backup the script
printed (it prints the exact commands). `--no-rollback` leaves the failed
version running for inspection instead.

Then, by hand:

4. Verify the dashboard, one S3 PUT/GET/DELETE, and the pending cleanup
   backlog.
5. Keep the previous image tag until the release is confirmed stable.

Without the script: take a backup (§6), pull or build the new image, run
`docker compose up -d` (or `bash scripts/deploy-pm2.sh`), and watch the startup
logs for `migrations applied`.

## 8. Rollback

`scripts/redeploy.sh` already returns to the previous code and image when an
update never becomes ready. To return to an older release afterwards, run
`bash scripts/redeploy.sh --ref <tag-or-commit>`; the old code runs on the
newer schema. When the data has to go back too:

1. Stop the container.
2. Restore the pre-upgrade backup with `--force` — `bun run db:restore`, or
   under Docker `docker compose run --rm gateway bun dist/scripts/restore-sqlite.js`.
3. Redeploy the previous image tag.
4. Start and re-verify.

## 9. Observability

The server logs JSON on stdout with a redaction list. Send logs to a central
sink and alert on:

- `INTERNAL_ERROR` responses;
- `SlowDown`/`ServiceUnavailable` spikes;
- backup failures;
- `pending_cleanup` backlog above a threshold.
