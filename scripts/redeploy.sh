#!/usr/bin/env bash
# Updates a running deployment to newer code: the upstream of the checked-out
# branch, or --ref (a tag, branch, or commit).
#
#   1. fetch, then fast-forward the branch (or check out the ref);
#   2. Compose: build the new image while the old version keeps serving;
#   3. back the database up, the old version still running;
#   4. restart on the new code -- Compose recreates the container, PM2 runs
#      deploy-pm2.sh -- and wait for /health/ready.
#
# If the new version does not become ready, the checkout and the image go back
# to what was running and that is started again. The database stays as the new
# version left it: migrations only ever add, so the old code still runs on it,
# and the backup from step 3 is there should the data have to go back as well.
#
# Everything runs from main(), which bash reads whole before running it: the
# fast-forward in step 1 replaces this very file.

set -Eeuo pipefail
LOG_TAG=redeploy
# shellcheck source=scripts/deploy-common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/deploy-common.sh"

# PM2 only; Compose backups land in ./data/backups, inside the container's volume.
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"

# Global, not local to main(): the EXIT trap needs them, and an exit through
# `set -e` runs the trap after main's locals are gone.
MODE=""
REF=""
TARGET=""
PREV_COMMIT=""
PREV_BRANCH=""
IMAGE=""
PREVIOUS_IMAGE=""
HAD_IMAGE=false
CHECKED_OUT=false
RESTARTED=false
BACKUP_PATH=""

usage() {
  cat <<'EOF'
Usage: bash scripts/redeploy.sh [--ref REF] [--force] [--no-backup] [--no-rollback]

  --ref REF       deploy REF (tag, branch, or commit) instead of the branch's upstream
  --force         rebuild and restart even when already at the target
  --no-backup     skip the database backup taken before the restart
  --no-rollback   if the new version is not ready, leave it running for inspection

Environment: ENV_FILE (default ./.env), READY_TIMEOUT_SECONDS (default 120),
PM2_APP_NAME (default drives3-gateway), BACKUP_DIR (PM2; default ./backups).
EOF
}

short() {
  git rev-parse --short "$1"
}

# The archive path from the backup tool's JSON report.
archive_from_report() {
  sed -n 's/^[[:space:]]*"encryptedPath": "\(.*\)",\{0,1\}$/\1/p' <<<"$1" | head -n 1
}

checkout_target() {
  if [[ -n "$REF" ]]; then
    git checkout --quiet --detach "$TARGET"
  else
    git merge --quiet --ff-only "$TARGET"
  fi
  CHECKED_OUT=true
}

restore_checkout() {
  log "Putting the checkout back at $(short "$PREV_COMMIT")"
  if [[ -n "$PREV_BRANCH" ]]; then
    git checkout --quiet "$PREV_BRANCH"
    git reset --quiet --keep "$PREV_COMMIT"
  else
    git checkout --quiet --detach "$PREV_COMMIT"
  fi
}

# Until the restart begins, a failure puts the checkout (and the image tag)
# back as they were; the old version never stopped.
on_exit() {
  local status=$?
  if ((status != 0)) && [[ "$CHECKED_OUT" == true && "$RESTARTED" == false ]]; then
    restore_checkout || warn "Could not put the checkout back at $PREV_COMMIT; do it by hand"
    if [[ "$HAD_IMAGE" == true ]]; then
      docker tag "$PREVIOUS_IMAGE" "$IMAGE" || true
    fi
    warn "Nothing was restarted: the version that was running still is"
  fi
}

restore_hint() {
  if [[ -z "$BACKUP_PATH" ]]; then
    printf 'No backup was taken this time.'
    return
  fi
  case "$MODE" in
    compose)
      printf 'Should the data have to go back too (DEPLOY.md section 8): cd %q && docker compose stop gateway && docker compose run --rm gateway bun dist/scripts/restore-sqlite.js --input /app/data/backups/%s --force && docker compose up -d gateway' \
        "$ROOT_DIR" "$(basename -- "$BACKUP_PATH")"
      ;;
    pm2)
      printf 'Should the data have to go back too (DEPLOY.md section 8): cd %q && pm2 stop %s && bun run db:restore -- --input %q --force && pm2 restart %s' \
        "$ROOT_DIR" "$APP_NAME" "$BACKUP_PATH" "$APP_NAME"
      ;;
  esac
}

# Backs up with the running container's own tool, which matches the schema it
# serves. An image from before the tool was bundled lacks it; the new image's
# copy then reads the same database from a one-off container.
backup_compose() {
  local report archive
  if compose exec -T gateway test -f dist/scripts/backup-sqlite.js >/dev/null 2>&1; then
    report="$(compose exec -T gateway bun dist/scripts/backup-sqlite.js --out /app/data/backups)"
  else
    report="$(compose run --rm --no-deps -T gateway bun dist/scripts/backup-sqlite.js --out /app/data/backups)"
  fi
  archive="$(archive_from_report "$report")"
  [[ -n "$archive" ]] || fail "The backup tool did not report an archive"
  BACKUP_PATH="$ROOT_DIR/data/backups/$(basename -- "$archive")"
}

backup_pm2() {
  local report
  report="$(cd "$ROOT_DIR" && bun --env-file="$ENV_FILE" scripts/backup-sqlite.ts --out "$BACKUP_DIR")"
  BACKUP_PATH="$(archive_from_report "$report")"
  [[ -n "$BACKUP_PATH" ]] || fail "The backup tool did not report an archive"
}

take_backup() {
  local backup="$1"
  if [[ "$backup" != true ]]; then
    warn "Skipping the database backup (--no-backup)"
    return
  fi
  log "Backing up the database before the new version migrates it"
  # Without the passphrase the tool asks for one at a terminal, but under
  # Compose (and anywhere unattended) there is no terminal to ask at.
  if [[ -z "$(env_value BACKUP_PASSPHRASE)" && ("$MODE" == compose || ! -t 0) ]]; then
    warn "BACKUP_PASSPHRASE is not set: this backup will only restore with MASTER_ENCRYPTION_KEY"
  fi
  "backup_$MODE"
  log "Backup: $BACKUP_PATH"
}

redeploy_compose() {
  local backup="$1" rollback="$2"
  IMAGE="$(compose_image)"
  PREVIOUS_IMAGE="$(rollback_image)"
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    docker tag "$IMAGE" "$PREVIOUS_IMAGE"
    HAD_IMAGE=true
  fi
  checkout_target
  log "Building the new image; the running version keeps serving meanwhile"
  compose build gateway || fail "The build failed"
  take_backup "$backup"

  log "Restarting on $(short "$TARGET")"
  RESTARTED=true
  compose_start
  if wait_ready; then
    log "Deployed $(short "$TARGET"); the previous image stays as $PREVIOUS_IMAGE"
    return 0
  fi
  show_diagnostics compose
  [[ "$rollback" == true ]] ||
    fail "The new version is not ready; left running for inspection (--no-rollback). $(restore_hint)"
  [[ "$HAD_IMAGE" == true ]] ||
    fail "The new version is not ready, and there was no previous image to go back to. $(restore_hint)"

  log "The new version is not ready; going back to $(short "$PREV_COMMIT")"
  docker tag "$PREVIOUS_IMAGE" "$IMAGE"
  restore_checkout
  compose_start
  if wait_ready; then
    fail "Rolled back: $(short "$PREV_COMMIT") is serving again, and $(short "$TARGET") is not deployed (its logs are above). $(restore_hint)"
  fi
  show_diagnostics compose
  fail "The previous version did not come back either. $(restore_hint)"
}

redeploy_pm2() {
  local backup="$1" rollback="$2"
  take_backup "$backup"
  checkout_target
  log "Building and restarting on $(short "$TARGET") with deploy-pm2.sh"
  # deploy-pm2.sh builds before it stops anything, but a failed build can
  # leave dist/ half replaced, so any failure rebuilds the old version.
  RESTARTED=true
  if pm2_deploy; then
    log "Deployed $(short "$TARGET")"
    return 0
  fi
  [[ "$rollback" == true ]] ||
    fail "The new version did not deploy; left as is (--no-rollback). $(restore_hint)"

  log "The new version did not deploy; going back to $(short "$PREV_COMMIT")"
  restore_checkout
  if pm2_deploy; then
    fail "Rolled back: $(short "$PREV_COMMIT") is serving again, and $(short "$TARGET") is not deployed (see above). $(restore_hint)"
  fi
  fail "The previous version did not come back either. $(restore_hint)"
}

main() {
  local force=false backup=true rollback=true
  while (($#)); do
    case "$1" in
      --ref)
        [[ $# -ge 2 && -n "$2" ]] || fail "--ref needs a tag, branch, or commit"
        REF="$2"
        shift
        ;;
      --force) force=true ;;
      --no-backup) backup=false ;;
      --no-rollback) rollback=false ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) fail "Unknown argument: $1 (see --help)" ;;
    esac
    shift
  done

  require_command git
  require_command curl
  cd "$ROOT_DIR"
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "$ROOT_DIR is not a git checkout"
  check_env
  take_deploy_lock

  MODE="$(deployed_mode)"
  case "$MODE" in
    compose) require_compose ;;
    pm2) require_pm2 ;;
    *) fail "Nothing is deployed from this checkout yet; run scripts/deploy.sh first" ;;
  esac
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    git status --short --untracked-files=no >&2
    fail "Tracked files have local changes; commit, stash, or discard them first"
  fi

  PREV_COMMIT="$(git rev-parse HEAD)"
  PREV_BRANCH="$(git symbolic-ref --quiet --short HEAD || true)"

  log "Fetching"
  git fetch --prune --tags --quiet || fail "Could not fetch; check the remote and its credentials"
  if [[ -n "$REF" ]]; then
    TARGET="$(git rev-parse --verify --quiet "$REF^{commit}")" || fail "Unknown ref: $REF"
  else
    [[ -n "$PREV_BRANCH" ]] || fail "HEAD is detached (an earlier --ref deploy); pass --ref, or check out a branch"
    git rev-parse --verify --quiet '@{upstream}' >/dev/null ||
      fail "Branch $PREV_BRANCH has no upstream to update from; pass --ref"
    TARGET="$(git rev-parse '@{upstream}')"
    git merge-base --is-ancestor HEAD "$TARGET" ||
      fail "Branch $PREV_BRANCH has commits its upstream lacks; a deployed checkout should only fast-forward"
  fi
  if [[ "$TARGET" == "$PREV_COMMIT" && "$force" != true ]]; then
    log "Already at $(short "$TARGET"); nothing to deploy (--force rebuilds and restarts it anyway)"
    exit 0
  fi
  if [[ "$TARGET" == "$PREV_COMMIT" ]]; then
    log "Rebuilding and restarting $(short "$TARGET") with $MODE (--force)"
  elif git merge-base --is-ancestor "$PREV_COMMIT" "$TARGET"; then
    log "Updating $(short "$PREV_COMMIT") -> $(short "$TARGET") with $MODE:"
    git --no-pager log --oneline --no-decorate -n 20 "$PREV_COMMIT..$TARGET" | sed 's/^/    /'
  else
    log "Moving $(short "$PREV_COMMIT") -> $(short "$TARGET") with $MODE (not a fast-forward of what is running)"
  fi

  trap on_exit EXIT
  "redeploy_$MODE" "$backup" "$rollback"
  [[ -z "$BACKUP_PATH" ]] || log "Pre-deploy backup: $BACKUP_PATH"
}

main "$@"
