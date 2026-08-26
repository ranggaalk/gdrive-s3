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

describe("GET /api/buckets/:id/traffic", () => {
  test("owner sees requests/bytes recorded for their bucket, defaulting to a 1h/minute window", async () => {
    const harness = makeHarness();
    const { ctx, seedUser } = harness;
    ctxToClose = ctx;
    const user = seedUser("owner@example.com");
    const bucket = ctx.repos.buckets.create(user.id, "reports", "us-east-1", "folder-1");
    ctx.repos.audit.record({
      userId: user.id,
      action: "s3.PutObject",
      bucketName: bucket.name,
      bucketId: bucket.id,
      objectKey: "a.txt",
      statusCode: 200,
      bytesIn: 1234,
      requestId: "seed-1",
    });

    const session = ctx.sessionService.establish({ userId: user.id, userAgent: "test", ip: null });
    const cookie = `drives3_sid=${session.rawId}`;
    const res = await handleApi(
      ctx,
      new Request(`http://localhost:5173/api/buckets/${bucket.id}/traffic`, { headers: { cookie } }),
      "req-traffic",
    );
    expect(res.status).toBe(200);
    const body = unwrap<{ range: string; granularity: string; points: Array<{ t: string; requests: number; bytesIn: number }> }>(
      await res.json(),
    );
    expect(body.range).toBe("1h");
    expect(body.granularity).toBe("minute");
    const totalRequests = body.points.reduce((sum, p) => sum + p.requests, 0);
    const totalBytesIn = body.points.reduce((sum, p) => sum + p.bytesIn, 0);
    expect(totalRequests).toBe(1);
    expect(totalBytesIn).toBe(1234);
  });

  test("rejects an unknown range value", async () => {
    const harness = makeHarness();
    const { ctx, seedUser } = harness;
    ctxToClose = ctx;
    const user = seedUser("owner2@example.com");
    const bucket = ctx.repos.buckets.create(user.id, "reports", "us-east-1", "folder-1");
    const session = ctx.sessionService.establish({ userId: user.id, userAgent: "test", ip: null });
    const cookie = `drives3_sid=${session.rawId}`;

    const res = await handleApi(
      ctx,
      new Request(`http://localhost:5173/api/buckets/${bucket.id}/traffic?range=1y`, { headers: { cookie } }),
      "req-bad-range",
    );
    expect(res.status).toBe(400);
  });

  test("a user with no access to the bucket cannot see its traffic", async () => {
    const harness = makeHarness();
    const { ctx, seedUser } = harness;
    ctxToClose = ctx;
    const owner = seedUser("owner3@example.com");
    const stranger = seedUser("stranger@example.com");
    const bucket = ctx.repos.buckets.create(owner.id, "private-reports", "us-east-1", "folder-2");
    const session = ctx.sessionService.establish({ userId: stranger.id, userAgent: "test", ip: null });
    const cookie = `drives3_sid=${session.rawId}`;

    const res = await handleApi(
      ctx,
      new Request(`http://localhost:5173/api/buckets/${bucket.id}/traffic`, { headers: { cookie } }),
      "req-denied",
    );
    expect(res.status).toBe(404);
  });
});
