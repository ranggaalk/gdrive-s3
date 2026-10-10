#!/usr/bin/env bash
# Deploys this checkout: checks the tools and .env, builds, starts the gateway
# on 127.0.0.1:8787, and waits for /health/ready. Run it for the first
# deployment, or to rebuild the current checkout in place; to update a running
# deployment to newer code, use redeploy.sh, which also backs up and rolls back.
#
# Docker Compose is used when Docker is available, PM2 otherwise; --compose or
# --pm2 chooses. Once a checkout is deployed one way it stays that way: two
# runtimes would put two processes on one SQLite database.
#
# Without a .env this creates one from .env.example, with a fresh
# MASTER_ENCRYPTION_KEY and SESSION_SECRET (and the public addresses, given
# --domain), then stops so the rest can be filled in.

set -Eeuo pipefail
LOG_TAG=deploy
# shellcheck source=scripts/deploy-common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/deploy-common.sh"

usage() {
  cat <<'EOF'
Usage: bash scripts/deploy.sh [--compose | --pm2] [--domain DOMAIN]

  --compose        deploy with Docker Compose (the default when Docker is installed)
  --pm2            deploy with PM2 (scripts/deploy-pm2.sh)
  --domain DOMAIN  when creating .env: the public host name, e.g. s3.example.com

Environment: ENV_FILE (default ./.env), READY_TIMEOUT_SECONDS (default 120),
PM2_APP_NAME (default drives3-gateway).
EOF
}

# Sets KEY in the env file, replacing its first line or appending one.
set_env_value() {
  local tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  awk -v key="$1" -v value="$2" '
    !done && index($0, key "=") == 1 { print key "=" value; done = 1; next }
    { print }
    END { if (!done) print key "=" value }
  ' "$ENV_FILE" >"$tmp"
  chmod 600 "$tmp"
  mv -- "$tmp" "$ENV_FILE"
}

create_env_file() {
  local domain="$1"
  require_command openssl
  [[ -f "$ROOT_DIR/.env.example" ]] || fail "No .env.example to start $ENV_FILE from"
  cp -- "$ROOT_DIR/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  set_env_value NODE_ENV production
  set_env_value MASTER_ENCRYPTION_KEY "$(openssl rand -base64 32)"
  set_env_value SESSION_SECRET "$(openssl rand -base64 48)"
  if [[ -n "$domain" ]]; then
    set_env_value APP_ORIGIN "https://$domain"
    set_env_value GOOGLE_REDIRECT_URI "https://$domain/auth/google/callback"
    set_env_value S3_PUBLIC_ENDPOINT "https://$domain"
    set_env_value S3_REQUIRE_TLS true
    set_env_value TRUST_PROXY true
  fi

  log "Created $ENV_FILE with a fresh MASTER_ENCRYPTION_KEY and SESSION_SECRET."
  log "Copy MASTER_ENCRYPTION_KEY into a password manager now: it seals every token"
  log "and secret in the database, and nothing else can open them (README step 4)."
  log "Fill in, then run this again:"
  log "  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET     from your Google OAuth client"
  log "  GOOGLE_WORKSPACE_DOMAIN and/or ALLOWED_EMAILS   who may sign in"
  if [[ -z "$domain" ]]; then
    log "  APP_ORIGIN, S3_PUBLIC_ENDPOINT             https://<your-domain>"
    log "  GOOGLE_REDIRECT_URI                        https://<your-domain>/auth/google/callback"
    log "  S3_REQUIRE_TLS=true, TRUST_PROXY=true      behind the HTTPS reverse proxy"
  fi
  log "  BACKUP_PASSPHRASE (recommended)            lets a backup restore without the master key"
  log "  ADMIN_EMAILS (optional)                    who may open Settings"
}

print_next_steps() {
  local mode="$1" origin
  origin="$(env_value APP_ORIGIN)"
  log "Ready: $READY_URL ($mode)"
  log "If not done yet:"
  log "  - an HTTPS reverse proxy from $origin to 127.0.0.1:8787 (README, Production deployment)"
  log "  - $origin/auth/google/callback as a redirect URI on the Google OAuth client"
  log "  - MASTER_ENCRYPTION_KEY and the recovery passphrase kept somewhere off this server"
  if [[ "$mode" == pm2 ]]; then
    log "  - pm2 startup, once per host (run the command it prints), so the gateway survives a reboot"
  fi
  log "Later updates: bash scripts/redeploy.sh"
}

main() {
  local mode="" domain=""
  while (($#)); do
    case "$1" in
      --compose) mode=compose ;;
      --pm2) mode=pm2 ;;
      --domain)
        [[ $# -ge 2 && -n "$2" ]] || fail "--domain needs a host name"
        domain="$2"
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) fail "Unknown argument: $1 (see --help)" ;;
    esac
    shift
  done
  if [[ "$domain" == *"://"* || "$domain" == */* ]]; then
    fail "--domain takes a host name such as s3.example.com, not a URL"
  fi

  require_command curl
  if [[ ! -f "$ENV_FILE" ]]; then
    create_env_file "$domain"
    exit 2
  fi
  [[ -z "$domain" ]] || warn "--domain only applies when creating $ENV_FILE; it already exists, so it is ignored"
  check_env
  take_deploy_lock

  local current
  current="$(deployed_mode)"
  if [[ -z "$mode" ]]; then
    if [[ "$current" != none ]]; then
      mode="$current"
    elif compose_available; then
      mode=compose
    elif command -v pm2 >/dev/null 2>&1; then
      mode=pm2
    else
      fail "Neither Docker Compose nor PM2 is installed; see the README's Production deployment"
    fi
  fi
  if [[ "$current" != none && "$current" != "$mode" ]]; then
    fail "This checkout is already deployed with $current; deploying it with $mode as well would put two processes on one database. Remove the $current deployment first."
  fi

  local revision
  revision="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || printf 'this checkout')"
  log "Deploying $revision with $mode"
  case "$mode" in
    compose)
      require_compose
      log "Building the image"
      compose build gateway
      prepare_data_dir
      log "Starting the gateway"
      compose_start
      if ! wait_ready; then
        show_diagnostics compose
        fail "The gateway did not become ready at $READY_URL; see the logs above"
      fi
      ;;
    pm2)
      require_pm2
      # Builds, starts, and waits for readiness itself.
      pm2_deploy
      ;;
  esac
  print_next_steps "$mode"
}

main "$@"
