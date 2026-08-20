import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { openMemoryDatabase } from "../../apps/server/src/db/connection.ts";
import { runMigrations } from "../../apps/server/src/db/migrate.ts";
import { createLogger } from "../../apps/server/src/observability/logger.ts";
import { createContext, type AppContext } from "../../apps/server/src/context.ts";
import { InMemoryDriveStorage } from "../../apps/server/src/drive/in-memory-storage.ts";
import { handleS3 } from "../../apps/server/src/s3/router.ts";
import { MultipartExpiryWorker } from "../../apps/server/src/jobs/multipart-expiry.ts";
import { CleanupWorker } from "../../apps/server/src/jobs/orphan-cleanup.ts";
import { testConfig } from "./_helpers.ts";

interface Live {
  server: ReturnType<typeof Bun.serve>;
  ctx: AppContext;
  client: S3Client;
  tempDir: string;
  userId: string;
}

async function bodyText(body: unknown): Promise<string> {
  if (body && typeof (body as { transformToString?: () => Promise<string> }).transformToString === "function") {
    return (body as { transformToString: () => Promise<string> }).transformToString();
  }
  return new Response(body as ReadableStream).text();
}

function md5(value: Uint8Array): string {
  return createHash("md5").update(value).digest("hex");
}

async function startLive(): Promise<Live> {
  const tempDir = mkdtempSync(join(tmpdir(), "drives3-m6-"));
  const config = testConfig({
    multipartTempDir: tempDir,
    minMultipartPartBytes: 1,
    driveResumableThresholdBytes: 1,
    driveUploadChunkBytes: 256 * 1024,
  });
  const db = openMemoryDatabase();
  runMigrations(db);
  const ctx = createContext(config, db, createLogger("error"), new InMemoryDriveStorage());
  const user = ctx.repos.users.upsertOnLogin({
    googleSub: "m6",
    email: "m6@x.com",
    displayName: null,
    hostedDomain: "x.com",
  });
  const credential = ctx.credentialService.create(user.id, "m6");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => handleS3(ctx, req, `req_${crypto.randomUUID()}`),
  });
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${server.port}`,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
    },
    maxAttempts: 1,
  });
  return { server, ctx, client, tempDir, userId: user.id };
}

describe("Milestone 6 AWS SDK compatibility", () => {
  let live: Live;

  beforeEach(async () => {
    live = await startLive();
  });

  afterEach(async () => {
    live.client.destroy();
    live.server.stop();
    live.ctx.db.close();
    rmSync(live.tempDir, { recursive: true, force: true });
  });

  test("multipart create, upload, list, complete, and GET", async () => {
    await live.client.send(new CreateBucketCommand({ Bucket: "multipart" }));
    const created = await live.client.send(
      new CreateMultipartUploadCommand({
        Bucket: "multipart",
        Key: "joined.txt",
        ContentType: "text/plain",
        Metadata: { source: "multipart" },
      }),
    );
    expect(created.UploadId).toMatch(/^mpu_[a-f0-9]{32}$/);

    const first = new TextEncoder().encode("hello ");
    const second = new TextEncoder().encode("world");
    const uploaded1 = await live.client.send(
      new UploadPartCommand({
        Bucket: "multipart",
        Key: "joined.txt",
        UploadId: created.UploadId,
        PartNumber: 1,
        Body: first,
      }),
    );
    const uploaded2 = await live.client.send(
      new UploadPartCommand({
        Bucket: "multipart",
        Key: "joined.txt",
        UploadId: created.UploadId,
        PartNumber: 2,
        Body: second,
      }),
    );
    expect(uploaded1.ETag).toBe(`"${md5(first)}"`);
    expect(uploaded2.ETag).toBe(`"${md5(second)}"`);

    const parts = await live.client.send(
      new ListPartsCommand({ Bucket: "multipart", Key: "joined.txt", UploadId: created.UploadId }),
    );
    expect(parts.Parts?.map((part) => part.PartNumber)).toEqual([1, 2]);
    const active = await live.client.send(new ListMultipartUploadsCommand({ Bucket: "multipart" }));
    expect(active.Uploads?.map((upload) => upload.UploadId)).toContain(created.UploadId);

    const completed = await live.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: "multipart",
        Key: "joined.txt",
        UploadId: created.UploadId,
        MultipartUpload: {
          Parts: [
            { PartNumber: 1, ETag: uploaded1.ETag },
            { PartNumber: 2, ETag: uploaded2.ETag },
          ],
        },
      }),
    );
    expect(completed.ETag).toMatch(/^"[0-9a-f]{32}-2"$/);
    const got = await live.client.send(new GetObjectCommand({ Bucket: "multipart", Key: "joined.txt" }));
    expect(await bodyText(got.Body)).toBe("hello world");
    expect(got.Metadata?.source).toBe("multipart");
  }, 15_000);

  test("abort removes upload and expiry queues then cleans temp parts", async () => {
    await live.client.send(new CreateBucketCommand({ Bucket: "cleanup" }));
    const aborted = await live.client.send(
      new CreateMultipartUploadCommand({ Bucket: "cleanup", Key: "abort.txt" }),
    );
    await live.client.send(
      new UploadPartCommand({
        Bucket: "cleanup",
        Key: "abort.txt",
        UploadId: aborted.UploadId,
        PartNumber: 1,
        Body: new TextEncoder().encode("discard"),
      }),
    );
    await live.client.send(
      new AbortMultipartUploadCommand({
        Bucket: "cleanup",
        Key: "abort.txt",
        UploadId: aborted.UploadId,
      }),
    );
    expect(live.ctx.repos.multipartUploads.byId(aborted.UploadId!)?.status).toBe("aborted");
    expect(live.ctx.repos.multipartParts.count(aborted.UploadId!)).toBe(0);

    const expired = await live.client.send(
      new CreateMultipartUploadCommand({ Bucket: "cleanup", Key: "expire.txt" }),
    );
    await live.client.send(
      new UploadPartCommand({
        Bucket: "cleanup",
        Key: "expire.txt",
        UploadId: expired.UploadId,
        PartNumber: 1,
        Body: new TextEncoder().encode("expired"),
      }),
    );
    live.ctx.db
      .query("UPDATE multipart_uploads SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", expired.UploadId!);
    const result = await new MultipartExpiryWorker(live.ctx).runOnce();
    expect(result).toMatchObject({ expired: 1, tempFilesEnqueued: 1 });
    expect(live.ctx.repos.multipartUploads.byId(expired.UploadId!)?.status).toBe("expired");
    expect(live.ctx.repos.pendingCleanup.backlog()).toBeGreaterThanOrEqual(2);
    await new CleanupWorker(live.ctx).runOnce();
    expect(live.ctx.repos.pendingCleanup.backlog()).toBe(0);
  }, 15_000);

  test("CopyObject COPY/REPLACE and presigned GET/PUT", async () => {
    await live.client.send(new CreateBucketCommand({ Bucket: "copy" }));
    await live.client.send(
      new PutObjectCommand({
        Bucket: "copy",
        Key: "source.txt",
        Body: new TextEncoder().encode("copy me"),
        ContentType: "text/plain",
        Metadata: { origin: "source" },
      }),
    );
    await live.client.send(
      new CopyObjectCommand({ Bucket: "copy", Key: "copied.txt", CopySource: "copy/source.txt" }),
    );
    const copied = await live.client.send(new GetObjectCommand({ Bucket: "copy", Key: "copied.txt" }));
    expect(await bodyText(copied.Body)).toBe("copy me");
    expect(copied.Metadata?.origin).toBe("source");

    await live.client.send(
      new CopyObjectCommand({
        Bucket: "copy",
        Key: "replaced.txt",
        CopySource: "copy/source.txt",
        MetadataDirective: "REPLACE",
        ContentType: "application/octet-stream",
        Metadata: { origin: "replacement" },
      }),
    );
    const replaced = await live.client.send(new GetObjectCommand({ Bucket: "copy", Key: "replaced.txt" }));
    expect(replaced.ContentType).toBe("application/octet-stream");
    expect(replaced.Metadata?.origin).toBe("replacement");

    const putUrl = await getSignedUrl(
      live.client,
      new PutObjectCommand({ Bucket: "copy", Key: "presigned.txt" }),
      { expiresIn: 60 },
    );
    const put = await fetch(putUrl, { method: "PUT", body: "signed body" });
    expect(put.status).toBe(200);
    const getUrl = await getSignedUrl(
      live.client,
      new GetObjectCommand({ Bucket: "copy", Key: "presigned.txt" }),
      { expiresIn: 60 },
    );
    const get = await fetch(getUrl);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("signed body");
  }, 15_000);
});
