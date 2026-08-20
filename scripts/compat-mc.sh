#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

is_minio_client() {
  "$1" --version 2>&1 | grep -Eqi 'MinIO Client|mc version RELEASE'
}

MC_BIN="${MINIO_MC_BIN:-}"
if [[ -n "$MC_BIN" ]]; then
  if ! command -v "$MC_BIN" >/dev/null 2>&1 || ! is_minio_client "$MC_BIN"; then
    echo '{"tool":"mc","verdict":"SKIP","reason":"MINIO_MC_BIN is not a MinIO Client binary"}'
    exit 0
  fi
else
  for candidate in mc mcli; do
    if command -v "$candidate" >/dev/null 2>&1 && is_minio_client "$candidate"; then
      MC_BIN="$candidate"
      break
    fi
  done
fi

if [[ -z "$MC_BIN" ]]; then
  echo '{"tool":"mc","verdict":"SKIP","reason":"MinIO Client binary not installed (mc may resolve to GNU Midnight Commander)"}'
  exit 0
fi

source scripts/compat-common.sh
start_gateway
export MC_CONFIG_DIR="$COMPAT_TMP/mc"

"$MC_BIN" alias set drives3 "$ENDPOINT" "$ACCESS_KEY" "$SECRET_KEY" --api S3v4 --path on >/dev/null
printf 'mc compatibility\n' >"$COMPAT_TMP/source.txt"
"$MC_BIN" mb "drives3/$BUCKET" >/dev/null
"$MC_BIN" cp "$COMPAT_TMP/source.txt" "drives3/$BUCKET/hello.txt" >/dev/null
"$MC_BIN" ls "drives3/$BUCKET" | grep -q 'hello.txt'
"$MC_BIN" cp "drives3/$BUCKET/hello.txt" "$COMPAT_TMP/download.txt" >/dev/null
cmp "$COMPAT_TMP/source.txt" "$COMPAT_TMP/download.txt"
"$MC_BIN" rm "drives3/$BUCKET/hello.txt" >/dev/null
"$MC_BIN" rb "drives3/$BUCKET" >/dev/null

MC_VERSION="$($MC_BIN --version 2>&1 | grep -Eo 'RELEASE\.[0-9TZ:-]+' | head -n 1 || true)"
printf '{"tool":"mc","verdict":"PASS","version":"%s"}\n' "${MC_VERSION:-unknown}"
