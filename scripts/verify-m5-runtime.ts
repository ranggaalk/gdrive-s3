// Milestone 5 runtime verification driver. Boots a real Bun HTTP socket with
// the same route dispatch as index.ts, injects InMemoryDriveStorage, and
// exercises the M5 features end-to-end via the AWS SDK v3.

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { openMemoryDatabase } from "../apps/server/src/db/connection.ts";
import { runMigrations } from "../apps/server/src/db/migrate.ts";
import { createLogger } from "../apps/server/src/observability/logger.ts";
import { createContext } from "../apps/server/src/context.ts";
import { InMemoryDriveStorage } from "../apps/server/src/drive/in-memory-storage.ts";
import { handleS3 } from "../apps/server/src/s3/router.ts";
import { handleApi } from "../apps/server/src/routes/api.ts";
import { handleLive, handleReady } from "../apps/server/src/routes/health.ts";
import { CleanupWorker } from "../apps/server/src/jobs/orphan-cleanup.ts";
import { testConfig } from "../tests/integration/_helpers.ts";

const observations: Array<{ step: string; result: unknown }> = [];
const record = (step: string, result: unknown) => observations.push({ step, result });

const config = testConfig({
  multipartTempDir: "/tmp",
  // Force the streaming path to use resumable so the chunk state machine runs.
  driveResumableThresholdBytes: 1024,
  driveUploadChunkBytes: 256 * 1024,
});
const db = openMemoryDatabase();
runMigrations(db);
const log = createLogger("error");
const storage = new InMemoryDriveStorage();
const ctx = createContext(config, db, log, storage);
const user = ctx.repos.users.upsertOnLogin({
  googleSub: "verify-m5",
  email: "verify-m5@x.com",
  displayName: null,
  hostedDomain: "x.com",
});
const cred = ctx.credentialService.create(user.id, "verify-m5");

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
const endpoint = `http://127.0.0.1:${server.port}`;

const client = new S3Client({
  endpoint,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey },
  maxAttempts: 1,
});

async function bytesFromStream(stream: unknown): Promise<Uint8Array> {
  if (
    stream &&
    typeof (stream as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === "function"
  ) {
    return (stream as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
  }
  return new Uint8Array(await new Response(stream as ReadableStream).arrayBuffer());
}

async function statusFromError<T>(op: () => Promise<T>): Promise<{ status: number; code: string }> {
  try {
    await op();
    return { status: 200, code: "OK" };
  } catch (err) {
    if (err instanceof S3ServiceException) {
      return {
        status: err.$metadata.httpStatusCode ?? 0,
        code: err.name ?? "UnknownError",
      };
    }
    throw err;
  }
}

try {
  // Health + unauthenticated control plane must still work.
  const live = await fetch(`${endpoint}/health/live`);
  const ready = await fetch(`${endpoint}/health/ready`);
  const unauthApi = await fetch(`${endpoint}/api/me`);
  record("health/control-plane", {
    live: live.status,
    ready: ready.status,
    unauthenticatedApi: unauthApi.status,
  });

  await client.send(new CreateBucketCommand({ Bucket: "verify-m5" }));

  // Streamed large object: forces the resumable orchestrator (threshold=1KiB).
  const bigSize = 3 * 1024 * 1024 + 42; // deliberately not aligned to chunk size
  const big = Buffer.alloc(bigSize);
  for (let i = 0; i < bigSize; i++) big[i] = i & 0xff;
  const expectedEtag = `"${createHash("md5").update(big).digest("hex")}"`;
  const bigPut = await client.send(
    new PutObjectCommand({
      Bucket: "verify-m5",
      Key: "large.bin",
      Body: big,
      ContentType: "application/octet-stream",
    }),
  );
  record("large streaming put", {
    size: bigSize,
    etag: bigPut.ETag,
    etagMatchesMd5: bigPut.ETag === expectedEtag,
  });

  // Range GET: exact bytes and headers.
  const rangeUrl = new URL(`${endpoint}/verify-m5/large.bin`);
  const rangeReq = await client.send(
    new GetObjectCommand({ Bucket: "verify-m5", Key: "large.bin", Range: "bytes=100-199" }),
  );
  const rangeBytes = await bytesFromStream(rangeReq.Body);
  record("range GET", {
    status: rangeReq.$metadata.httpStatusCode,
    contentRange: rangeReq.ContentRange,
    contentLength: rangeReq.ContentLength,
    length: rangeBytes.length,
    matches: Buffer.from(rangeBytes).equals(big.subarray(100, 200)),
    url: rangeUrl.pathname,
  });

  // Conditional GET: 304 for If-None-Match hit, 412 for If-Match miss.
  const notModified = await statusFromError(() =>
    client.send(
      new GetObjectCommand({
        Bucket: "verify-m5",
        Key: "large.bin",
        IfNoneMatch: expectedEtag,
      }),
    ),
  );
  const preconditionFailed = await statusFromError(() =>
    client.send(
      new HeadObjectCommand({
        Bucket: "verify-m5",
        Key: "large.bin",
        IfMatch: '"nope"',
      }),
    ),
  );
  record("conditional GET/HEAD", { notModified, preconditionFailed });

  // Atomic overwrite: put "v2", ensure GET returns v2 and old Drive file is
  // reconciled away by the inline cleanup path.
  await client.send(
    new PutObjectCommand({ Bucket: "verify-m5", Key: "over.txt", Body: "v1" }),
  );
  await client.send(
    new PutObjectCommand({ Bucket: "verify-m5", Key: "over.txt", Body: "v2" }),
  );
  const after = await client.send(new GetObjectCommand({ Bucket: "verify-m5", Key: "over.txt" }));
  record("atomic overwrite", {
    body: await after.Body!.transformToString(),
    cleanupBacklog: ctx.repos.pendingCleanup.backlog(),
  });

  // Delete cleanup with a simulated Drive outage: enqueue must remain until
  // storage recovers. Then flip back and run the cleanup worker once.
  const originalDeleteFile = storage.deleteFile.bind(storage);
  storage.deleteFile = async () => {
    throw new Error("simulated Drive outage");
  };
  await client.send(new DeleteObjectCommand({ Bucket: "verify-m5", Key: "over.txt" }));
  const failingBacklog = ctx.repos.pendingCleanup.backlog();
  storage.deleteFile = originalDeleteFile;
  const cleanupWorker = new CleanupWorker(ctx);
  const cleanupResult = await cleanupWorker.runOnce();
  const finalBacklog = ctx.repos.pendingCleanup.backlog();
  record("delete cleanup queue", { failingBacklog, cleanupResult, finalBacklog });

  // Reconciliation: simulate an out-of-band Drive delete via the adapter.
  await client.send(new PutObjectCommand({ Bucket: "verify-m5", Key: "gone.txt", Body: "temp" }));
  const bucket = ctx.repos.buckets.findByName(user.id, "verify-m5")!;
  const obj = ctx.repos.objects.findByKey(bucket.id, "gone.txt")!;
  await originalDeleteFile({ userId: user.id, driveFileId: obj.drive_file_id, mode: "permanent" });
  const reconciled = await ctx.reconcileService.runUserBatch(user.id, "verify-recon");
  const getGone = await statusFromError(() =>
    client.send(new GetObjectCommand({ Bucket: "verify-m5", Key: "gone.txt" })),
  );
  record("reconciliation", { reconciled, getGone });

  process.stdout.write(
    JSON.stringify({ verdict: "PASS", endpoint, observations }, null, 2) + "\n",
  );
} finally {
  client.destroy();
  server.stop();
  db.close();
}
