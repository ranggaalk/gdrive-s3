#!/usr/bin/env bash
# Local approximation of the Docker runtime: boots dist/server/index.js against
# the production static layout to prove the bundled entrypoint honours
# MIGRATIONS_DIR and dashboard STATIC_ROOT.

set -euo pipefail
cd "$(dirname "$0")/.."

BUN="${BUN:-$HOME/.bun/bin/bun}"
ROOT="${SMOKE_ROOT:-/tmp/drives3-dockerlike}"

rm -rf "$ROOT"
mkdir -p "$ROOT/data/multipart" "$ROOT/dist/server/migrations"
cp apps/server/src/db/migrations/*.sql "$ROOT/dist/server/migrations/"
cp dist/server/index.js "$ROOT/dist/server/index.js"
cp -R dist/web "$ROOT/dist/web"

KEY=$(openssl rand -base64 32)
SECRET=$(openssl rand -base64 32)
PORT="${SMOKE_PORT:-34567}"

env \
  NODE_ENV=development \
  GOOGLE_WORKSPACE_DOMAIN=example.com \
  GOOGLE_CLIENT_ID=cid \
  GOOGLE_CLIENT_SECRET=csecret \
  GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback \
  MASTER_ENCRYPTION_KEY="$KEY" \
  SESSION_SECRET="$SECRET" \
  SQLITE_PATH="$ROOT/data/app.sqlite" \
  MULTIPART_TEMP_DIR="$ROOT/data/multipart" \
  STATIC_ROOT="$ROOT/dist/web" \
  MIGRATIONS_DIR="$ROOT/dist/server/migrations" \
  SERVER_HOST=127.0.0.1 \
  SERVER_PORT="$PORT" \
  "$BUN" "$ROOT/dist/server/index.js" >"$ROOT/server.log" 2>&1 &
PID=$!

trap 'kill -TERM "$PID" 2>/dev/null; wait "$PID" 2>/dev/null' EXIT

for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/health/live" >/dev/null; then break; fi
  sleep 0.1
done

echo '# /health/live'
curl -sf "http://127.0.0.1:$PORT/health/live"
echo
echo '# / (dashboard)'
curl -sfI "http://127.0.0.1:$PORT/" | tr -d '\r' | head -6
echo '# server log tail'
tail -6 "$ROOT/server.log"
