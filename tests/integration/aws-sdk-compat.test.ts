// Compatibility smoke test using the official AWS SDK v3 against our server,
// backed by the in-memory Drive adapter. Boots the server on an ephemeral
// port, drives create/put/list/get/delete through the SDK, and verifies
// wire-level compatibility (path-style, SigV4 header auth, XML responses).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { openMemoryDatabase } from "../../apps/server/src/db/connection.ts";
import { runMigrations } from "../../apps/server/src/db/migrate.ts";
import { createLogger } from "../../apps/server/src/observability/logger.ts";
import { createContext, type AppContext } from "../../apps/server/src/context.ts";
import { InMemoryDriveStorage } from "../../apps/server/src/drive/in-memory-storage.ts";
import { handleS3 } from "../../apps/server/src/s3/router.ts";
import { testConfig } from "./_helpers.ts";

interface Live {
  server: ReturnType<typeof Bun.serve>;
  ctx: AppContext;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

async function bytesFromStream(stream: unknown): Promise<Uint8Array> {
  if (stream && typeof (stream as { transformToByteArray?: () => Promise<Uint8Array> })
    .transformToByteArray === "function") {
    return (stream as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
  }
  return new Uint8Array(await new Response(stream as ReadableStream).arrayBuffer());
}

async function startServer(): Promise<Live> {
  const config = testConfig();
  const db = openMemoryDatabase();
  runMigrations(db);
  const log = createLogger("error");
  const storage = new InMemoryDriveStorage();
  const ctx = createContext(config, db, log, storage);
  const user = ctx.repos.users.upsertOnLogin({
    googleSub: "s",
    email: "s@x.com",
    displayName: null,
    hostedDomain: "x.com",
  });
  const cred = ctx.credentialService.create(user.id, "sdk");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => handleS3(ctx, req, `req_${crypto.randomUUID()}`),
  });
  return {
    server,
    ctx,
    endpoint: `http://127.0.0.1:${server.port}`,
    accessKeyId: cred.accessKeyId,
    secretAccessKey: cred.secretAccessKey,
  };
}

describe("AWS SDK v3 compatibility", () => {
  let live: Live;
  let client: S3Client;

  beforeEach(async () => {
    live = await startServer();
    client = new S3Client({
      endpoint: live.endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: live.accessKeyId,
        secretAccessKey: live.secretAccessKey,
      },
    });
  });

  afterEach(async () => {
    client.destroy();
    live.server.stop();
  });

  test("create bucket, put + get object, list, delete", async () => {
    await client.send(new CreateBucketCommand({ Bucket: "hello" }));

    const buckets = await client.send(new ListBucketsCommand({}));
    expect((buckets.Buckets ?? []).map((b) => b.Name)).toContain("hello");

    const body = new TextEncoder().encode("hello sdk\n");
    const put = await client.send(
      new PutObjectCommand({
        Bucket: "hello",
        Key: "greeting.txt",
        Body: body,
        ContentType: "text/plain",
        Metadata: { origin: "sdk" },
      }),
    );
    expect(put.ETag).toMatch(/^"[0-9a-f]{32}"$/);

    const head = await client.send(new HeadObjectCommand({ Bucket: "hello", Key: "greeting.txt" }));
    expect(head.ContentType).toBe("text/plain");
    expect(head.ContentLength).toBe(body.length);
    expect(head.Metadata?.origin).toBe("sdk");

    const got = await client.send(new GetObjectCommand({ Bucket: "hello", Key: "greeting.txt" }));
    const bytes = await bytesFromStream(got.Body);
    expect(new TextDecoder().decode(bytes)).toBe("hello sdk\n");

    const listV1 = await client.send(new ListObjectsCommand({ Bucket: "hello" }));
    expect((listV1.Contents ?? []).map((o) => o.Key)).toEqual(["greeting.txt"]);

    const list = await client.send(new ListObjectsV2Command({ Bucket: "hello" }));
    expect((list.Contents ?? []).map((o) => o.Key)).toEqual(["greeting.txt"]);

    await client.send(new DeleteObjectCommand({ Bucket: "hello", Key: "greeting.txt" }));
    await client.send(new DeleteBucketCommand({ Bucket: "hello" }));
  }, 15000);

  test("list objects with prefix + delimiter", async () => {
    await client.send(new CreateBucketCommand({ Bucket: "layout" }));
    for (const Key of ["a", "dir/one", "dir/two", "z"]) {
      await client.send(
        new PutObjectCommand({ Bucket: "layout", Key, Body: new TextEncoder().encode(Key) }),
      );
    }
    const list = await client.send(new ListObjectsV2Command({ Bucket: "layout", Delimiter: "/" }));
    expect((list.Contents ?? []).map((o) => o.Key)).toEqual(["a", "z"]);
    expect((list.CommonPrefixes ?? []).map((p) => p.Prefix)).toEqual(["dir/"]);
  }, 15000);
});
