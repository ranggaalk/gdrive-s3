# Performance & load testing

DriveS3 Gateway ships a Bun-native load harness under `scripts/loadtest/`. It
boots an ephemeral Bun HTTP socket backed by in-memory SQLite and
`InMemoryDriveStorage`; therefore the numbers measure gateway routing,
SigV4/XML, SQLite metadata, streaming/chunk orchestration, and HTTP overhead —
not Google Drive latency or quota behaviour.

## Quick smoke

Run through WSL:

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd ~/Projects/gdrive-s3
bun scripts/loadtest/index.ts \
  --duration 5s \
  --concurrency 16 \
  --scenarios put,get,list,multipart
```

Equivalent package script:

```bash
bun run load:test -- --duration 5s --concurrency 16
```

## Scenarios

- `put`: repeated 64 KiB single-object uploads to unique keys.
- `get`: repeated full reads of a seeded 1 MiB object (body fully consumed).
- `list`: `ListObjectsV2` over 100 seeded keys (`MaxKeys=100`).
- `multipart`: complete three-part uploads (3 × 256 KiB) to unique keys.

Each scenario runs for the configured duration and produces:

- successful request/lifecycle count;
- error count;
- throughput (`rps`);
- mean, p50, p95, p99, and maximum latency;
- retained sample count (bounded to 100,000).

## Interpreting results

The harness is for regression comparison, not production capacity planning.
Google Drive has per-user quota/rate limits, network latency, resumable retries,
and OAuth refresh latency that the in-memory adapter does not model. For a
production-like benchmark:

1. Deploy the Docker image behind the intended TLS reverse proxy.
2. Use dedicated Google Workspace test users and isolated buckets.
3. Keep `MAX_USER_UPLOADS`, `MAX_USER_DOWNLOADS`, and
   `MAX_USER_DRIVE_REQUESTS` at production values.
4. Run a remote load generator so server and client do not compete for the
   same CPU.
5. Record Drive rate-limit/quota responses and cleanup backlog in addition to
   latency.

Do not raise concurrency limits based solely on this in-memory result. The
Drive API's actual quota is the practical upper bound.
