import { afterEach, describe, expect, test } from "bun:test";
import type { AppContext } from "../../apps/server/src/context.ts";
import { handleApi } from "../../apps/server/src/routes/api.ts";
import { makeHarness } from "./_helpers.ts";

function unwrap<T>(body: unknown): T {
  return (body as { data: T }).data;
}

let ctxToClose: AppContext | null = null;
afterEach(() => {
  ctxToClose?.db.close();
  ctxToClose = null;
});

describe("GET /api/traffic (dashboard-wide overview)", () => {
  test("sums traffic across every bucket the user owns, ignoring buckets they don't", async () => {
    const harness = makeHarness();
    const { ctx, seedUser } = harness;
    ctxToClose = ctx;
    const user = seedUser("owner@example.com");
    const stranger = seedUser("stranger@example.com");
    const bucketA = ctx.repos.buckets.create(user.id, "reports", "us-east-1", "folder-1");
    const bucketB = ctx.repos.buckets.create(user.id, "backups", "us-east-1", "folder-2");
    const strangerBucket = ctx.repos.buckets.create(stranger.id, "private", "us-east-1", "folder-3");

    ctx.repos.audit.record({
      userId: user.id,
      action: "s3.PutObject",
      bucketName: bucketA.name,
      bucketId: bucketA.id,
      objectKey: "a.txt",
      statusCode: 200,
      bytesIn: 100,
      requestId: "seed-a",
    });
    ctx.repos.audit.record({
      userId: user.id,
      action: "s3.PutObject",
      bucketName: bucketB.name,
      bucketId: bucketB.id,
      objectKey: "b.txt",
      statusCode: 200,
      bytesIn: 250,
      requestId: "seed-b",
    });
    ctx.repos.audit.record({
      userId: stranger.id,
      action: "s3.PutObject",
      bucketName: strangerBucket.name,
      bucketId: strangerBucket.id,
      objectKey: "c.txt",
      statusCode: 200,
      bytesIn: 9999,
      requestId: "seed-c",
    });

    const session = ctx.sessionService.establish({ userId: user.id, userAgent: "test", ip: null });
    const cookie = `drives3_sid=${session.rawId}`;
    const res = await handleApi(
      ctx,
      new Request("http://localhost:5173/api/traffic", { headers: { cookie } }),
      "req-overview-traffic",
    );
    expect(res.status).toBe(200);
    const body = unwrap<{ points: Array<{ bytesIn: number }> }>(await res.json());
    const totalBytesIn = body.points.reduce((sum, p) => sum + p.bytesIn, 0);
    expect(totalBytesIn).toBe(350);
  });

  test("returns an all-zero series for a user with no buckets", async () => {
    const harness = makeHarness();
    const { ctx, seedUser } = harness;
    ctxToClose = ctx;
    const user = seedUser("empty@example.com");
    const session = ctx.sessionService.establish({ userId: user.id, userAgent: "test", ip: null });
    const cookie = `drives3_sid=${session.rawId}`;

    const res = await handleApi(
      ctx,
      new Request("http://localhost:5173/api/traffic", { headers: { cookie } }),
      "req-overview-empty",
    );
    expect(res.status).toBe(200);
    const body = unwrap<{ points: Array<{ requests: number }> }>(await res.json());
    expect(body.points.every((p) => p.requests === 0)).toBe(true);
  });
});
