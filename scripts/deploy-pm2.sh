#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="${PM2_APP_NAME:-drives3-gateway}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
SOURCE_MIGRATIONS="$ROOT_DIR/apps/server/src/db/migrations"
MIGRATIONS_DIR="$ROOT_DIR/dist/server/migrations"
STATIC_ROOT="$ROOT_DIR/dist/web"
SERVER_ENTRY="$ROOT_DIR/dist/server/index.js"
READY_URL="http://127.0.0.1:8787/health/ready"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-60}"

log() {
  printf '[deploy-pm2] %s\n' "$*"
}

fail() {
  printf '[deploy-pm2] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

show_diagnostics() {
  pm2 list || true
  if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    pm2 describe "$APP_NAME" || true
    pm2 logs "$APP_NAME" --nostream --lines 100 || true
  fi
}

require_command bun
require_command pm2
require_command curl
[[ -f "$ENV_FILE" ]] || fail "Environment file not found: $ENV_FILE"
[[ -d "$SOURCE_MIGRATIONS" ]] || fail "Migration directory not found: $SOURCE_MIGRATIONS"
compgen -G "$SOURCE_MIGRATIONS/*.sql" >/dev/null || fail "No SQL migrations found in $SOURCE_MIGRATIONS"
[[ "$READY_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || fail "READY_TIMEOUT_SECONDS must be a positive integer"

BUN_BIN="$(command -v bun)"
cd "$ROOT_DIR"

log "Installing locked dependencies"
bun install --frozen-lockfile

log "Building dashboard and server"
bun run build

[[ -f "$SERVER_ENTRY" ]] || fail "Server build missing: $SERVER_ENTRY"
[[ -f "$STATIC_ROOT/index.html" ]] || fail "Dashboard build missing: $STATIC_ROOT/index.html"

log "Bundling database migrations"
rm -rf -- "$MIGRATIONS_DIR"
mkdir -p -- "$MIGRATIONS_DIR"
cp -- "$SOURCE_MIGRATIONS"/*.sql "$MIGRATIONS_DIR/"

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  log "Stopping existing PM2 process"
  pm2 delete "$APP_NAME"
fi

log "Starting one PM2 fork process on 127.0.0.1:8787"
if ! NODE_ENV=production \
  SERVER_HOST=127.0.0.1 \
  SERVER_PORT=8787 \
  S3_REQUIRE_TLS=true \
  STATIC_ROOT="$STATIC_ROOT" \
  MIGRATIONS_DIR="$MIGRATIONS_DIR" \
  pm2 start "$BUN_BIN" \
    --name "$APP_NAME" \
    --cwd "$ROOT_DIR" \
    --interpreter none \
    --instances 1 \
    --kill-timeout 30000 \
    --restart-delay 3000 \
    -- \
    "--env-file=$ENV_FILE" \
    "$SERVER_ENTRY"; then
  show_diagnostics
  fail "PM2 could not start $APP_NAME"
fi

log "Waiting up to ${READY_TIMEOUT_SECONDS}s for $READY_URL"
ready=false
for ((attempt = 1; attempt <= READY_TIMEOUT_SECONDS; attempt += 1)); do
  if curl --fail --silent --show-error --max-time 2 "$READY_URL" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "$ready" != true ]]; then
  show_diagnostics
  fail "Readiness check failed: $READY_URL"
fi

pm2 save
log "Deployment ready: $APP_NAME"
log "Health: $READY_URL"
log "Status: pm2 describe $APP_NAME"
log "Logs: pm2 logs $APP_NAME"
