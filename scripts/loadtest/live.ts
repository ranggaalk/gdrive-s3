// Ephemeral in-memory gateway used by the load harness. Keeps server lifecycle
// isolated from scenario code so each load run cleans up deterministically.

import { S3Client } from "@aws-sdk/client-s3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDatabase } from "../../apps/server/src/db/connection.ts";
import { runMigrations } from "../../apps/server/src/db/migrate.ts";
import { createLogger } from "../../apps/server/src/observability/logger.ts";
import { createContext } from "../../apps/server/src/context.ts";
import { InMemoryDriveStorage } from "../../apps/server/src/drive/in-memory-storage.ts";
import { handleS3 } from "../../apps/server/src/s3/router.ts";
import { handleLive, handleReady } from "../../apps/server/src/routes/health.ts";
import { testConfig } from "../../tests/integration/_helpers.ts";

export interface LoadGateway {
  client: S3Client;
  bucket: string;
  endpoint: string;
  close(): void;
}

export function startLoadGateway(): LoadGateway {
  const tempDir = mkdtempSync(join(tmpdir(), "drives3-load-"));
  const config = testConfig({
    multipartTempDir: tempDir,
    minMultipartPartBytes: 1,
    driveResumableThresholdBytes: 128 * 1024,
    driveUploadChunkBytes: 256 * 1024,
    maxUserUploads: 256,
    maxUserDownloads: 256,
    maxUserDriveRequests: 512,
    rateLimit: {
      ...testConfig().rateLimit,
      enabled: false,
    },
  });
  const db = openMemoryDatabase();
  runMigrations(db);
  const ctx = createContext(config, db, createLogger("error"), new InMemoryDriveStorage());
  const user = ctx.repos.users.upsertOnLogin({
    googleSub: "load-test",
    email: "load@x.com",
    displayName: null,
    hostedDomain: "x.com",
  });
  const credential = ctx.credentialService.create(user.id, "load-test");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const requestId = `req_${crypto.randomUUID()}`;
      if (path === "/health/live") return handleLive();
      if (path === "/health/ready") return handleReady(db, config);
      return handleS3(ctx, req, requestId);
    },
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const client = new S3Client({
    endpoint,
    region: config.s3Region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
    },
    maxAttempts: 1,
  });
  return {
    client,
    bucket: `load-${crypto.randomUUID().slice(0, 8)}`,
    endpoint,
    close() {
      client.destroy();
      server.stop();
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}
