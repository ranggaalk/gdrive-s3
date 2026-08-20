#!/usr/bin/env bash
# Shared lifecycle for optional AWS CLI/rclone/mc compatibility smoke tests.
# Source this file from the project root, then call start_gateway/stop_gateway.

set -euo pipefail

COMPAT_TMP="$(mktemp -d)"
COMPAT_INFO="$COMPAT_TMP/gateway.jsonl"
COMPAT_ERR="$COMPAT_TMP/gateway.err"
COMPAT_PID=""

json_field() {
  local field="$1"
  bun -e 'const line=(await Bun.file(process.argv[1]).text()).split("\n")[0]; console.log(JSON.parse(line)[process.argv[2]])' \
    "$COMPAT_INFO" "$field"
}

start_gateway() {
  bun scripts/verify-m7-runtime.ts >"$COMPAT_INFO" 2>"$COMPAT_ERR" &
  COMPAT_PID=$!
  for _ in $(seq 1 100); do
    if [[ -s "$COMPAT_INFO" ]]; then break; fi
    if ! kill -0 "$COMPAT_PID" 2>/dev/null; then
      cat "$COMPAT_ERR" >&2
      return 1
    fi
    sleep 0.05
  done
  [[ -s "$COMPAT_INFO" ]] || { echo "gateway did not start" >&2; return 1; }
  ENDPOINT="$(json_field endpoint)"
  REGION="$(json_field region)"
  ACCESS_KEY="$(json_field accessKeyId)"
  SECRET_KEY="$(json_field secretAccessKey)"
  BUCKET="$(json_field bucketName)"
  export ENDPOINT REGION ACCESS_KEY SECRET_KEY BUCKET
}

stop_gateway() {
  if [[ -n "${COMPAT_PID:-}" ]]; then
    kill -TERM "$COMPAT_PID" 2>/dev/null || true
    wait "$COMPAT_PID" 2>/dev/null || true
  fi
  rm -rf "$COMPAT_TMP"
}

trap stop_gateway EXIT INT TERM
