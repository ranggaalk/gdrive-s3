#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v rclone >/dev/null 2>&1; then
  echo '{"tool":"rclone","verdict":"SKIP","reason":"rclone binary not installed"}'
  exit 0
fi

source scripts/compat-common.sh
start_gateway
CONF="$COMPAT_TMP/rclone.conf"
cat >"$CONF" <<EOF
[drives3]
type = s3
provider = Other
env_auth = false
access_key_id = $ACCESS_KEY
secret_access_key = $SECRET_KEY
endpoint = $ENDPOINT
region = $REGION
force_path_style = true
list_chunk = 2
EOF

printf 'rclone compatibility\n' >"$COMPAT_TMP/source.txt"
rclone mkdir --config "$CONF" "drives3:$BUCKET"
rclone copyto --config "$CONF" "$COMPAT_TMP/source.txt" "drives3:$BUCKET/hello.txt"
rclone copyto --config "$CONF" "$COMPAT_TMP/source.txt" "drives3:$BUCKET/nested/one.txt"
rclone copyto --config "$CONF" "$COMPAT_TMP/source.txt" "drives3:$BUCKET/second/two.txt"
rclone lsf --config "$CONF" "drives3:$BUCKET" | grep -q '^hello.txt$'
rclone lsf --config "$CONF" "drives3:$BUCKET" | grep -q '^nested/$'
rclone lsf --recursive --config "$CONF" "drives3:$BUCKET" | grep -q '^nested/one.txt$'
rclone copyto --config "$CONF" "drives3:$BUCKET/hello.txt" "$COMPAT_TMP/download.txt"
cmp "$COMPAT_TMP/source.txt" "$COMPAT_TMP/download.txt"
rclone deletefile --config "$CONF" "drives3:$BUCKET/hello.txt"
rclone deletefile --config "$CONF" "drives3:$BUCKET/nested/one.txt"
rclone deletefile --config "$CONF" "drives3:$BUCKET/second/two.txt"
rclone rmdir --config "$CONF" "drives3:$BUCKET"

echo '{"tool":"rclone","verdict":"PASS"}'
