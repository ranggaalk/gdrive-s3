#!/usr/bin/env bash
# M3 smoke runner. Seeds a session, boots the server, exercises the API.
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"
cd "$(dirname "$0")/.."

rm -f data/app.sqlite data/app.sqlite-*
bun scripts/smoke-m3.ts > /tmp/seed.json
RAW=$(sed -n 's/.*"rawId":"\([^"]*\)".*/\1/p' /tmp/seed.json)
CSRF=$(sed -n 's/.*"csrf":"\([^"]*\)".*/\1/p' /tmp/seed.json)
echo "raw len: ${#RAW} csrf len: ${#CSRF}"

bun apps/server/src/index.ts > /tmp/drives3.log 2>&1 &
SVR=$!
sleep 1.5
C="-b drives3_sid=$RAW"

echo "--- me ---"
curl -s $C http://localhost:3000/api/me; echo
echo "--- create cred (CSRF) ---"
curl -s $C -H "X-CSRF-Token: $CSRF" -H "Content-Type: application/json" -X POST -d '{"label":"my key"}' http://localhost:3000/api/credentials; echo
echo "--- create cred no CSRF (expect 403) ---"
curl -s -o /dev/null -w "[%{http_code}]\n" $C -X POST -d '{}' http://localhost:3000/api/credentials
echo "--- list creds (secret absent) ---"
curl -s $C http://localhost:3000/api/credentials; echo
echo "--- buckets ---"
curl -s $C http://localhost:3000/api/buckets; echo
echo "--- audit ---"
curl -s $C http://localhost:3000/api/audit; echo
echo "--- bucket create no CSRF (expect 403) ---"
curl -s -o /dev/null -w "[%{http_code}]\n" $C -X POST -d '{"name":"docs"}' http://localhost:3000/api/buckets

kill $SVR 2>/dev/null || true
echo done
