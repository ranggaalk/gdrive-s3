#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v aws >/dev/null 2>&1; then
  echo '{"tool":"aws-cli","verdict":"SKIP","reason":"aws binary not installed"}'
  exit 0
fi

source scripts/compat-common.sh
start_gateway
export AWS_ACCESS_KEY_ID="$ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$SECRET_KEY"
export AWS_DEFAULT_REGION="$REGION"
export AWS_EC2_METADATA_DISABLED=true

printf 'aws-cli compatibility\n' >"$COMPAT_TMP/source.txt"
aws --endpoint-url "$ENDPOINT" s3api create-bucket --bucket "$BUCKET" >/dev/null
aws --endpoint-url "$ENDPOINT" s3 cp "$COMPAT_TMP/source.txt" "s3://$BUCKET/hello.txt" --no-progress >/dev/null
aws --endpoint-url "$ENDPOINT" s3 ls "s3://$BUCKET/" | grep -q 'hello.txt'
aws --endpoint-url "$ENDPOINT" s3 cp "s3://$BUCKET/hello.txt" "$COMPAT_TMP/download.txt" --no-progress >/dev/null
cmp "$COMPAT_TMP/source.txt" "$COMPAT_TMP/download.txt"
aws --endpoint-url "$ENDPOINT" s3 rm "s3://$BUCKET/hello.txt" >/dev/null
aws --endpoint-url "$ENDPOINT" s3api delete-bucket --bucket "$BUCKET" >/dev/null

echo '{"tool":"aws-cli","verdict":"PASS"}'
