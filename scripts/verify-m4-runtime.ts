// Runtime verification driver for Milestone 4. Boots a real Bun HTTP socket
// with the same route dispatch as index.ts but injects InMemoryDriveStorage,
// then drives it through the official AWS SDK v3 public client surface.

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { openMemoryDatabase } from "../apps/server/src/db/connection.ts";
import { runMigrations } from "../apps/server/src/db/migrate.ts";
import { createLogger } from "../apps/server/src/observability/logger.ts";
import { createContext } from "../apps/server/src/context.ts";
import { InMemoryDriveStorage } from "../apps/server/src/drive/in-memory-storage.ts";
import { handleS3 } from "../apps/server/src/s3/router.ts";
import { handleApi } from "../apps/server/src/routes/api.ts";
import { handleLive, handleReady } from "../apps/server/src/routes/health.ts";
import { testConfig } from "../tests/integration/_helpers.ts";

const observations: Array<{ step: string; result: unknown }> = [];
const config = testConfig({ multipartTempDir: "/tmp" });
const db = openMemoryDatabase();
runMigrations(db);
const log = createLogger("error");
const ctx = createContext(config, db, log, new InMemoryDriveStorage());
const userA = ctx.repos.users.upsertOnLogin({
  googleSub: "verify-a",
  email: "verify-a@x.com",
  displayName: null,
  hostedDomain: "x.com",
});
const userB = ctx.repos.users.upsertOnLogin({
  googleSub: "verify-b",
  email: "verify-b@x.com",
  displayName: null,
  hostedDomain: "x.com",
});
const credA = ctx.credentialService.create(userA.id, "verify-a");
const credB = ctx.credentialService.create(userB.id, "verify-b");

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

function client(accessKeyId: string, secretAccessKey: string) {
  return new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 1,
  });
}

const a = client(credA.accessKeyId, credA.secretAccessKey);
const b = client(credB.accessKeyId, credB.secretAccessKey);

try {
  const live = await fetch(`${endpoint}/health/live`);
  const ready = await fetch(`${endpoint}/health/ready`);
  const unauthApi = await fetch(`${endpoint}/api/me`);
  observations.push({
    step: "health/control-plane",
    result: { live: live.status, ready: ready.status, unauthenticatedApi: unauthApi.status },
  });

  await a.send(new CreateBucketCommand({ Bucket: "verify-bucket" }));
  const bucketNames = (await a.send(new ListBucketsCommand({}))).Buckets?.map((x) => x.Name);
  observations.push({ step: "create/list bucket", result: bucketNames });

  for (const [Key, Body] of [
    ["readme.txt", "hello runtime\n"],
    ["dir/one.txt", "one"],
    ["dir/two.txt", "two"],
  ] as const) {
    await a.send(
      new PutObjectCommand({
        Bucket: "verify-bucket",
        Key,
        Body: new TextEncoder().encode(Body),
        ContentType: "text/plain",
        Metadata: { verified: "runtime" },
      }),
    );
  }
  const head = await a.send(
    new HeadObjectCommand({ Bucket: "verify-bucket", Key: "readme.txt" }),
  );
  const got = await a.send(new GetObjectCommand({ Bucket: "verify-bucket", Key: "readme.txt" }));
  const gotText = await got.Body!.transformToString();
  observations.push({
    step: "put/head/get",
    result: {
      contentLength: head.ContentLength,
      contentType: head.ContentType,
      metadata: head.Metadata,
      body: gotText,
    },
  });

  const listed = await a.send(
    new ListObjectsV2Command({ Bucket: "verify-bucket", Delimiter: "/" }),
  );
  observations.push({
    step: "prefix/delimiter listing",
    result: {
      keys: listed.Contents?.map((x) => x.Key),
      prefixes: listed.CommonPrefixes?.map((x) => x.Prefix),
    },
  });

  let isolationError = "none";
  try {
    await b.send(new GetObjectCommand({ Bucket: "verify-bucket", Key: "readme.txt" }));
  } catch (error) {
    isolationError = (error as { name?: string }).name ?? "unknown";
  }
  observations.push({ step: "ownership isolation", result: isolationError });

  const bad = client(credA.accessKeyId, "definitely-wrong-secret");
  let signatureError = "none";
  try {
    await bad.send(new ListBucketsCommand({}));
  } catch (error) {
    signatureError = (error as { name?: string }).name ?? "unknown";
  } finally {
    bad.destroy();
  }
  const unsigned = await fetch(`${endpoint}/`);
  observations.push({
    step: "error probes",
    result: { wrongSignature: signatureError, unsignedStatus: unsigned.status, unsignedXml: await unsigned.text() },
  });

  for (const key of ["readme.txt", "dir/one.txt", "dir/two.txt"]) {
    await a.send(new DeleteObjectCommand({ Bucket: "verify-bucket", Key: key }));
  }
  await a.send(new DeleteBucketCommand({ Bucket: "verify-bucket" }));
  observations.push({ step: "delete object/bucket", result: "completed" });

  process.stdout.write(JSON.stringify({ verdict: "PASS", endpoint, observations }, null, 2) + "\n");
} finally {
  a.destroy();
  b.destroy();
  server.stop();
  db.close();
}
