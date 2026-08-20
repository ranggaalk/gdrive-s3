// Milestone 6 runtime verification driver. Boots a real Bun HTTP socket with
// the same route dispatch as index.ts, injects InMemoryDriveStorage, and
// exercises multipart, presigned SigV4 query, and CopyObject via AWS SDK v3
// plus @aws-sdk/s3-request-presigner.

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDatabase } from "../apps/server/src/db/connection.ts";
import { runMigrations } from "../apps/server/src/db/migrate.ts";
import { createLogger } from "../apps/server/src/observability/logger.ts";
import { createContext } from "../apps/server/src/context.ts";
import { InMemoryDriveStorage } from "../apps/server/src/drive/in-memory-storage.ts";
import { handleS3 } from "../apps/server/src/s3/router.ts";
import { handleApi } from "../apps/server/src/routes/api.ts";
import { handleLive, handleReady } from "../apps/server/src/routes/health.ts";
import { CleanupWorker } from "../apps/server/src/jobs/orphan-cleanup.ts";
import { MultipartExpiryWorker } from "../apps/server/src/jobs/multipart-expiry.ts";
import { testConfig } from "../tests/integration/_helpers.ts";

const observations: Array<{ step: string; result: unknown }> = [];
const record = (step: string, result: unknown) => observations.push({ step, result });

const tempDir = mkdtempSync(join(tmpdir(), "drives3-m6-runtime-"));
const config = testConfig({
  multipartTempDir: tempDir,
  driveResumableThresholdBytes: 1024,
  driveUploadChunkBytes: 256 * 1024,
  minMultipartPartBytes: 1,
});
const db = openMemoryDatabase();
runMigrations(db);
const log = createLogger("error");
const storage = new InMemoryDriveStorage();
const ctx = createContext(config, db, log, storage);
const user = ctx.repos.users.upsertOnLogin({
  googleSub: "verify-m6",
  email: "verify-m6@x.com",
  displayName: null,
  hostedDomain: "x.com",
});
const credential = ctx.credentialService.create(user.id, "verify-m6");

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
  credentials: {
    accessKeyId: credential.accessKeyId,
    secretAccessKey: credential.secretAccessKey,
  },
  maxAttempts: 1,
});

async function bodyText(body: unknown): Promise<string> {
  if (body && typeof (body as { transformToString?: () => Promise<string> }).transformToString === "function") {
    return (body as { transformToString: () => Promise<string> }).transformToString();
  }
  return new Response(body as ReadableStream).text();
}

const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");

try {
  const live = await fetch(`${endpoint}/health/live`);
  record("health", { live: live.status });

  await client.send(new CreateBucketCommand({ Bucket: "verify-m6" }));

  // Multipart lifecycle: 3 parts, complete, GET body equals concat.
  const create = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: "verify-m6",
      Key: "big.bin",
      ContentType: "application/octet-stream",
      Metadata: { case: "multipart" },
    }),
  );
  const parts = [
    new Uint8Array(1024 * 512).map((_, i) => i & 0xff),
    new Uint8Array(1024 * 256).map((_, i) => (i * 3) & 0xff),
    new Uint8Array(37).map((_, i) => 0xa0 ^ i),
  ];
  const etags: Array<{ number: number; etag: string }> = [];
  for (let index = 0; index < parts.length; index++) {
    const uploaded = await client.send(
      new UploadPartCommand({
        Bucket: "verify-m6",
        Key: "big.bin",
        UploadId: create.UploadId,
        PartNumber: index + 1,
        Body: parts[index]!,
      }),
    );
    etags.push({ number: index + 1, etag: uploaded.ETag! });
  }
  const listActive = await client.send(new ListMultipartUploadsCommand({ Bucket: "verify-m6" }));
  const listParts = await client.send(
    new ListPartsCommand({ Bucket: "verify-m6", Key: "big.bin", UploadId: create.UploadId }),
  );
  const completed = await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: "verify-m6",
      Key: "big.bin",
      UploadId: create.UploadId,
      MultipartUpload: {
        Parts: etags.map((entry) => ({ PartNumber: entry.number, ETag: entry.etag })),
      },
    }),
  );
  const combined = Buffer.concat(parts.map((part) => Buffer.from(part)));
  const expectedEtag =
    createHash("md5").update(Buffer.concat(etags.map((entry) => Buffer.from(entry.etag.replaceAll(`"`, ""), "hex"))))
      .digest("hex") + `-${etags.length}`;
  const fetched = await client.send(new GetObjectCommand({ Bucket: "verify-m6", Key: "big.bin" }));
  const fetchedBytes = new Uint8Array(await new Response(fetched.Body as ReadableStream).arrayBuffer());
  record("multipart upload", {
    activeCount: (listActive.Uploads ?? []).length,
    listedParts: (listParts.Parts ?? []).length,
    etag: completed.ETag,
    etagMatches: completed.ETag === `"${expectedEtag}"`,
    bodyMatches: Buffer.from(fetchedBytes).equals(combined),
    metadata: fetched.Metadata,
  });

  // Abort clears temp files.
  const toAbort = await client.send(new CreateMultipartUploadCommand({ Bucket: "verify-m6", Key: "abort.bin" }));
  await client.send(
    new UploadPartCommand({
      Bucket: "verify-m6",
      Key: "abort.bin",
      UploadId: toAbort.UploadId,
      PartNumber: 1,
      Body: new TextEncoder().encode("scrap"),
    }),
  );
  await client.send(
    new AbortMultipartUploadCommand({
      Bucket: "verify-m6",
      Key: "abort.bin",
      UploadId: toAbort.UploadId,
    }),
  );
  await new CleanupWorker(ctx).runOnce();
  record("abort cleanup", {
    partsRemaining: ctx.repos.multipartParts.count(toAbort.UploadId!),
    backlog: ctx.repos.pendingCleanup.backlog(),
  });

  // Expiry worker: force TTL into the past and re-run.
  const expiring = await client.send(new CreateMultipartUploadCommand({ Bucket: "verify-m6", Key: "expiring.bin" }));
  await client.send(
    new UploadPartCommand({
      Bucket: "verify-m6",
      Key: "expiring.bin",
      UploadId: expiring.UploadId,
      PartNumber: 1,
      Body: new TextEncoder().encode("expired"),
    }),
  );
  db.query("UPDATE multipart_uploads SET expires_at = ? WHERE id = ?").run(
    "2000-01-01T00:00:00.000Z",
    expiring.UploadId!,
  );
  const expiry = await new MultipartExpiryWorker(ctx).runOnce();
  await new CleanupWorker(ctx).runOnce();
  record("multipart expiry", {
    expiry,
    row: ctx.repos.multipartUploads.byId(expiring.UploadId!)?.status,
    backlog: ctx.repos.pendingCleanup.backlog(),
  });

  // CopyObject with default COPY and REPLACE directives.
  await client.send(
    new PutObjectCommand({
      Bucket: "verify-m6",
      Key: "src.txt",
      Body: new TextEncoder().encode("copy source"),
      ContentType: "text/plain",
      Metadata: { origin: "src" },
    }),
  );
  await client.send(
    new CopyObjectCommand({ Bucket: "verify-m6", Key: "dst.txt", CopySource: "verify-m6/src.txt" }),
  );
  await client.send(
    new CopyObjectCommand({
      Bucket: "verify-m6",
      Key: "dst-replace.txt",
      CopySource: "verify-m6/src.txt",
      MetadataDirective: "REPLACE",
      ContentType: "application/octet-stream",
      Metadata: { origin: "replacement" },
    }),
  );
  const copied = await client.send(new GetObjectCommand({ Bucket: "verify-m6", Key: "dst.txt" }));
  const replaced = await client.send(new GetObjectCommand({ Bucket: "verify-m6", Key: "dst-replace.txt" }));
  record("copy object", {
    copyBody: await bodyText(copied.Body),
    copyMetadata: copied.Metadata,
    replaceContentType: replaced.ContentType,
    replaceMetadata: replaced.Metadata,
  });

  // Presigned GET/PUT round-trip via fetch.
  const putUrl = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: "verify-m6", Key: "presigned.txt" }),
    { expiresIn: 60 },
  );
  const putResponse = await fetch(putUrl, { method: "PUT", body: "presigned body" });
  const getUrl = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: "verify-m6", Key: "presigned.txt" }),
    { expiresIn: 60 },
  );
  const getResponse = await fetch(getUrl);
  const expired = await fetch(getUrl.replace(/X-Amz-Expires=\d+/, "X-Amz-Expires=1"));
  record("presigned", {
    putStatus: putResponse.status,
    getStatus: getResponse.status,
    getBody: await getResponse.text(),
    tamperedStatus: expired.status,
  });

  process.stdout.write(
    JSON.stringify({ verdict: "PASS", endpoint, observations }, null, 2) + "\n",
  );
} finally {
  client.destroy();
  server.stop();
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
}

void md5;
