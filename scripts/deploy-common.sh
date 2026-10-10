# shellcheck shell=bash
# Shared by deploy.sh and redeploy.sh. Sourced, not run; the caller sets
# `set -Eeuo pipefail` and LOG_TAG.
#
# A checkout is deployed with exactly one runtime: Docker Compose (the gateway
# service in docker-compose.yml) or PM2 (scripts/deploy-pm2.sh). Two runtimes
# on one data directory would mean two processes on one SQLite database, so
# these helpers refuse that rather than pick one.

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
APP_NAME="${PM2_APP_NAME:-drives3-gateway}"
READY_URL="${READY_URL:-http://127.0.0.1:8787/health/ready}"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-120}"
# The container's user; ./data is bind-mounted and must belong to it.
APP_UID=1010

log() {
  printf '[%s] %s\n' "$LOG_TAG" "$*"
}

warn() {
  printf '[%s] WARNING: %s\n' "$LOG_TAG" "$*" >&2
}

fail() {
  printf '[%s] ERROR: %s\n' "$LOG_TAG" "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

compose() {
  docker compose --project-directory "$ROOT_DIR" -f "$ROOT_DIR/docker-compose.yml" "$@"
}

# The image docker-compose.yml builds the gateway into, and the tag the
# previous one is kept under so a failed update can go back to it.
compose_image() {
  local image
  image="$(compose config --images gateway 2>/dev/null | head -n 1)"
  [[ -n "$image" ]] || fail "Could not read the gateway image name from docker-compose.yml"
  printf '%s' "$image"
}

rollback_image() {
  local image
  image="$(compose_image)"
  printf '%s:previous' "${image%:*}"
}

# One deploy at a time per checkout. The lock is released when the script exits.
take_deploy_lock() {
  if ! command -v flock >/dev/null 2>&1; then
    warn "flock is not installed; not guarding against two deploys at once"
    return
  fi
  exec 9>"$ROOT_DIR/.deploy.lock"
  flock -n 9 || fail "Another deploy or redeploy is already running in $ROOT_DIR"
}

# The value of KEY in the env file, or empty. The file is read as data and
# never sourced: a value there is configuration, not shell to run.
env_value() {
  local line value
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  value="${line#*=}"
  value="${value%$'\r'}"
  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$value"
}

# The settings the server cannot start in production without. The server
# checks all of this again at boot; checking here first fails before anything
# is built or stopped.
check_env() {
  [[ -f "$ENV_FILE" ]] || fail "Environment file not found: $ENV_FILE (run scripts/deploy.sh to create one)"
  local key missing=()
  for key in APP_ORIGIN GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REDIRECT_URI MASTER_ENCRYPTION_KEY SESSION_SECRET; do
    [[ -n "$(env_value "$key")" ]] || missing+=("$key")
  done
  if [[ -z "$(env_value GOOGLE_WORKSPACE_DOMAIN)$(env_value ALLOWED_EMAILS)" ]]; then
    missing+=("GOOGLE_WORKSPACE_DOMAIN or ALLOWED_EMAILS")
  fi
  ((${#missing[@]} == 0)) || fail "Set these in $ENV_FILE first: ${missing[*]}"

  local origin endpoint
  origin="$(env_value APP_ORIGIN)"
  [[ "$origin" == https://* ]] || fail "APP_ORIGIN must be the public https:// address in production, not $origin"
  endpoint="$(env_value S3_PUBLIC_ENDPOINT)"
  if [[ "$endpoint" != https://* ]]; then
    warn "S3_PUBLIC_ENDPOINT is '${endpoint:-unset}'; presigned URLs point there, so set it to the public https:// address"
  fi
}

compose_available() {
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
}

require_compose() {
  require_command docker
  docker compose version >/dev/null 2>&1 || fail "The Docker Compose plugin is not installed (docker compose version)"
  docker info >/dev/null 2>&1 || fail "Cannot reach the Docker daemon: is it running, and may $(id -un) use it?"
}

require_pm2() {
  require_command bun
  require_command pm2
}

# compose, pm2, or none: how this checkout is deployed right now.
deployed_mode() {
  local in_compose=false in_pm2=false
  if compose_available && [[ -n "$(compose ps -a -q gateway 2>/dev/null)" ]]; then
    in_compose=true
  fi
  if command -v pm2 >/dev/null 2>&1 && pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    in_pm2=true
  fi
  if [[ "$in_compose" == true && "$in_pm2" == true ]]; then
    fail "Both a Compose container and the PM2 process $APP_NAME exist for this checkout; two processes must never share one database. Remove one (docker compose down, or pm2 delete $APP_NAME) and run this again."
  fi
  if [[ "$in_compose" == true ]]; then
    printf 'compose'
  elif [[ "$in_pm2" == true ]]; then
    printf 'pm2'
  else
    printf 'none'
  fi
}

# ./data is a bind mount, so it keeps the host directory's owner; Docker
# creates a missing one as root, and the non-root container could not then
# create its database. The chown runs in a throwaway container of the built
# image rather than through sudo: whoever may use Docker can do this anyway,
# and a deploy should not stop half way for a password prompt.
prepare_data_dir() {
  mkdir -p -- "$ROOT_DIR/data"
  local owner
  owner="$(stat -c '%u' "$ROOT_DIR/data")"
  [[ "$owner" == "$APP_UID" ]] && return
  log "Handing ./data to uid $APP_UID, the container's user"
  if [[ "$(id -u)" == 0 ]]; then
    chown -R "$APP_UID:$APP_UID" "$ROOT_DIR/data"
  else
    docker run --rm --user 0:0 --entrypoint chown -v "$ROOT_DIR/data:/data" "$(compose_image)" \
      -R "$APP_UID:$APP_UID" /data
  fi
}

wait_ready() {
  log "Waiting up to ${READY_TIMEOUT_SECONDS}s for $READY_URL"
  local attempt
  for ((attempt = 1; attempt <= READY_TIMEOUT_SECONDS; attempt += 1)); do
    if curl --fail --silent --max-time 2 "$READY_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

show_diagnostics() {
  case "$1" in
    compose)
      compose ps -a gateway || true
      compose logs --no-color --tail 80 gateway || true
      ;;
    pm2)
      pm2 describe "$APP_NAME" || true
      pm2 logs "$APP_NAME" --nostream --lines 80 || true
      ;;
  esac
}

compose_start() {
  compose up -d --no-build gateway
}

pm2_deploy() {
  ENV_FILE="$ENV_FILE" PM2_APP_NAME="$APP_NAME" READY_TIMEOUT_SECONDS="$READY_TIMEOUT_SECONDS" \
    bash "$ROOT_DIR/scripts/deploy-pm2.sh"
}
