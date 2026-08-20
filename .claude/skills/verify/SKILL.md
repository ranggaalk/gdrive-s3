---
name: verify
summary: Verify DriveS3 through real Bun HTTP sockets and AWS SDK v3.
---

Run everything via WSL. The M6 driver adds multipart, presigned query SigV4,
CopyObject, and expiry checks; earlier drivers remain valid for regression
coverage.

```bash
# Milestone 4 surface (SigV4, path-style CRUD, metadata, listing).
wsl.exe -d ubuntu-22.04 bash -lc 'export PATH="$HOME/.bun/bin:$PATH"; cd ~/Projects/gdrive-s3 && bun scripts/verify-m4-runtime.ts'

# Milestone 5 surface (large streaming put, range/conditional GET, atomic
# overwrite, delete cleanup queue with failure injection, reconciliation).
wsl.exe -d ubuntu-22.04 bash -lc 'export PATH="$HOME/.bun/bin:$PATH"; cd ~/Projects/gdrive-s3 && bun scripts/verify-m5-runtime.ts'

# Milestone 6 surface (multipart upload/abort/expiry, CopyObject COPY/REPLACE,
# presigned SigV4 query GET/PUT).
wsl.exe -d ubuntu-22.04 bash -lc 'export PATH="$HOME/.bun/bin:$PATH"; cd ~/Projects/gdrive-s3 && bun scripts/verify-m6-runtime.ts'

# Milestone 7 live socket for external clients. This process stays alive until
# SIGTERM; prefer one of the compat scripts below when a client is installed.
wsl.exe -d ubuntu-22.04 bash -lc 'export PATH="$HOME/.bun/bin:$PATH"; cd ~/Projects/gdrive-s3 && bun scripts/verify-m7-runtime.ts'

# Optional external-client compatibility smokes; each reports SKIP when its
# binary is not installed.
wsl.exe -d ubuntu-22.04 bash -lc 'export PATH="$HOME/.bun/bin:$PATH"; cd ~/Projects/gdrive-s3 && bash scripts/compat-aws-cli.sh'
wsl.exe -d ubuntu-22.04 bash -lc 'export PATH="$HOME/.bun/bin:$PATH"; cd ~/Projects/gdrive-s3 && bash scripts/compat-rclone.sh'
wsl.exe -d ubuntu-22.04 bash -lc 'export PATH="$HOME/.bun/bin:$PATH"; cd ~/Projects/gdrive-s3 && bash scripts/compat-mc.sh'
```

Each driver spins up an ephemeral Bun server backed by `InMemoryDriveStorage`
and exercises the public HTTP surface with `@aws-sdk/client-s3`
(`forcePathStyle: true`). A successful run prints JSON containing
`"verdict": "PASS"` and per-step observations. No persistent SQLite or Drive
state is written.
