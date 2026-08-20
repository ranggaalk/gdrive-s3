// Milestone 7 runtime driver. Boots an ephemeral Bun HTTP socket dispatching
// the full router (health + auth + api + s3) against InMemoryDriveStorage,
// prints one JSON line describing the endpoint and access credentials, then
// stays alive until stdin closes or SIGTERM/SIGINT so external clients
// (aws/rclone/mc) can exercise the wire format.

import { openMemoryDatabase } from "../apps/server/src/db/connection.ts";
import { runMigrations } from "../apps/server/src/db/migrate.ts";
import { createLogger } from "../apps/server/src/observability/logger.ts";
import { createContext } from "../apps/server/src/context.ts";
import { InMemoryDriveStorage } from "../apps/server/src/drive/in-memory-storage.ts";
import { handleS3 } from "../apps/server/src/s3/router.ts";
import { handleApi } from "../apps/server/src/routes/api.ts";
import { handleLive, handleReady } from "../apps/server/src/routes/health.ts";
import { testConfig } from "../tests/integration/_helpers.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "drives3-m7-runtime-"));
const config = testConfig({
  multipartTempDir: tempDir,
  minMultipartPartBytes: 1,
  driveResumableThresholdBytes: 1024,
  driveUploadChunkBytes: 256 * 1024,
});
const db = openMemoryDatabase();
runMigrations(db);
const log = createLogger("error");
const storage = new InMemoryDriveStorage();
const ctx = createContext(config, db, log, storage);
const user = ctx.repos.users.upsertOnLogin({
  googleSub: "verify-m7",
  email: "verify-m7@x.com",
  displayName: null,
  hostedDomain: "x.com",
});
const credential = ctx.credentialService.create(user.id, "verify-m7");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const requestId = `req_${crypto.randomUUID()}`;
    if (path === "/health/live") return handleLive();
    if (path === "/health/ready") return handleReady(db, config);
    if (path.startsWith("/api/")) return handleApi(ctx, req, requestId);
    return handleS3(ctx, req, requestId);
  },
});

const info = {
  endpoint: `http://127.0.0.1:${server.port}`,
  region: config.s3Region,
  accessKeyId: credential.accessKeyId,
  secretAccessKey: credential.secretAccessKey,
  bucketName: `verify-m7-${crypto.randomUUID().slice(0, 8)}`,
  pid: process.pid,
};
process.stdout.write(JSON.stringify(info) + "\n");

function shutdown(reason: string): void {
  server.stop();
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  process.stderr.write(`verify-m7-runtime shutdown (${reason})\n`);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
// Keep the harness alive for external CLI smoke scripts. They terminate it
// with SIGTERM in their trap.
setInterval(() => {}, 60 * 60 * 1000).unref?.();
await new Promise<void>(() => {});
