import { afterEach, describe, expect, test } from "bun:test";
import type { AppContext } from "../../apps/server/src/context.ts";
import { handleApi } from "../../apps/server/src/routes/api.ts";
import { DriveQuotaService } from "../../apps/server/src/services/drive-quota-service.ts";
import { DriveQuotaProbe } from "../../apps/server/src/drive/quota-probe.ts";
import { parseServiceAccountKey } from "../../apps/server/src/auth/google-service-account.ts";
import { generateKeyPairSync } from "node:crypto";
import { makeHarness } from "./_helpers.ts";

function unwrap<T>(body: unknown): T {
  return (body as { data: T }).data;
}

let ctxToClose: AppContext | null = null;
afterEach(() => {
  ctxToClose?.db.close();
  ctxToClose = null;
});

const ORIGIN = "http://localhost:5173";

interface QuotaView {
  observed: {
    totalRequests: number;
    totalThrottled: number;
    windows: Array<{ windowSeconds: number; requests: number; throttled: number; perMinute: number }>;
    recentThrottles: Array<{ reason: string | null; retryAfterMs: number | null }>;
    users: Array<{ userId: string; email: string | null; requestsLastHour: number }>;
  };
  concurrency: { uploadsPerUser: number; apiRequestsPerUser: number };
  storage: { limitBytes: number | null; usageBytes: number; remainingBytes: number | null; usedRatio: number | null } | null;
  storageError: string | null;
  live: { configured: boolean; error?: string; rows?: Array<{ metric: string; remaining: number | null }> };
  canSeeUsers: boolean;
}

function setup(options: { admin?: boolean } = {}) {
  const harness = makeHarness({ appOrigin: ORIGIN });
  const { ctx } = harness;
  ctxToClose = ctx;
  const user = ctx.repos.users.upsertOnLogin({
    googleSub: "sub-owner@x.com",
    email: "owner@x.com",
    displayName: null,
    hostedDomain: "x.com",
    isAdmin: options.admin ?? false,
  });
  const session = ctx.sessionService.establish({ userId: user.id, userAgent: "test", ip: null });

  const api = (path: string, init: RequestInit = {}) =>
    handleApi(
      ctx,
      new Request(`${ORIGIN}${path}`, {
        ...init,
        headers: {
          cookie: `drives3_sid=${session.rawId}`,
          origin: ORIGIN,
          ...(init.method && init.method !== "GET" ? { "x-csrf-token": session.csrfSecret } : {}),
        },
      }),
      `req_${crypto.randomUUID()}`,
    );

  const quota = async () => unwrap<QuotaView>(await (await api("/api/drive/quota")).json());
  return { harness, ctx, user, api, quota };
}

describe("GET /api/drive/quota", () => {
  test("reports the calls this gateway actually made", async () => {
    const { ctx, user, quota } = setup();
    ctx.driveQuotaMeter.record({
      userId: user.id, kind: "api", status: 200, throttled: false, reason: null, retryAfterMs: null,
    });
    ctx.driveQuotaMeter.record({
      userId: user.id, kind: "upload", status: 200, throttled: false, reason: null, retryAfterMs: null,
    });

    const view = await quota();
    expect(view.observed.totalRequests).toBe(2);
    const minute = view.observed.windows.find((w) => w.windowSeconds === 60)!;
    expect(minute.requests).toBe(2);
  });

  test("surfaces the throttles Google actually returned", async () => {
    const { ctx, user, quota } = setup();
    ctx.driveQuotaMeter.record({
      userId: user.id, kind: "api", status: 403,
      throttled: true, reason: "userRateLimitExceeded", retryAfterMs: 5000,
    });

    const view = await quota();
    expect(view.observed.totalThrottled).toBe(1);
    expect(view.observed.recentThrottles[0]).toMatchObject({
      reason: "userRateLimitExceeded",
      retryAfterMs: 5000,
    });
  });

  test("reads the account's live storage quota", async () => {
    const { quota } = setup();
    const view = await quota();
    expect(view.storageError).toBeNull();
    expect(view.storage!.limitBytes).toBe(15 * 1024 ** 3);
    expect(view.storage!.remainingBytes).toBe(15 * 1024 ** 3);
    expect(view.storage!.usedRatio).toBe(0);
  });

  test("says live quota is unconfigured rather than guessing a remaining figure", async () => {
    const { quota } = setup();
    const view = await quota();
    expect(view.live.configured).toBe(false);
    expect(view.live.rows).toBeUndefined();
    expect(view.live.error).toContain("service account");
  });

  test("reports the gateway's own concurrency caps alongside Google's", async () => {
    const { quota } = setup();
    const view = await quota();
    expect(view.concurrency.uploadsPerUser).toBe(4);
    expect(view.concurrency.apiRequestsPerUser).toBe(8);
  });

  test("hides the per-user breakdown from non-admins", async () => {
    const { ctx, user, quota } = setup();
    ctx.driveQuotaMeter.record({
      userId: user.id, kind: "api", status: 200, throttled: false, reason: null, retryAfterMs: null,
    });

    const view = await quota();
    expect(view.canSeeUsers).toBe(false);
    expect(view.observed.users).toEqual([]);
    // The aggregate is still visible: it is the number that matters for quota.
    expect(view.observed.totalRequests).toBe(1);
  });

  test("shows admins who is spending the quota, resolved to an email", async () => {
    const { ctx, user, quota } = setup({ admin: true });
    ctx.driveQuotaMeter.record({
      userId: user.id, kind: "api", status: 200, throttled: false, reason: null, retryAfterMs: null,
    });
    ctx.driveQuotaMeter.record({
      userId: "ghost", kind: "api", status: 200, throttled: false, reason: null, retryAfterMs: null,
    });

    const view = await quota();
    expect(view.canSeeUsers).toBe(true);
    expect(view.observed.users.find((u) => u.userId === user.id)!.email).toBe("owner@x.com");
    // A user id the gateway no longer knows still shows its usage.
    expect(view.observed.users.find((u) => u.userId === "ghost")!.email).toBeNull();
  });

  test("rejects a non-GET", async () => {
    const { api } = setup();
    expect((await api("/api/drive/quota", { method: "POST" })).status).toBe(405);
  });

  test("keeps working when the Drive account cannot be read", async () => {
    const { harness, ctx, quota } = setup();
    harness.storage.getStorageQuota = async () => {
      throw new (await import("../../apps/server/src/drive/errors.ts")).DriveError({
        status: 403, category: "forbidden", message: "no",
      });
    };
    ctx.driveQuotaService = new DriveQuotaService(
      ctx.config, ctx.driveQuotaMeter, harness.storage, null,
    );

    const view = await quota();
    expect(view.storage).toBeNull();
    expect(view.storageError).toBe("forbidden");
    // The observed counters survive a broken Drive connection.
    expect(view.observed.windows.length).toBeGreaterThan(0);
  });

  test("serves live quota when a probe is configured", async () => {
    const { ctx, harness, quota } = setup();
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = parseServiceAccountKey(
      JSON.stringify({
        type: "service_account",
        project_id: "proj",
        client_email: "quota@proj.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      }),
    );

    const fetcher = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("oauth2")) return Response.json({ access_token: "at", expires_in: 3600 });
      if (url.includes("serviceusage")) {
        return Response.json({
          metrics: [{
            metric: "drive.googleapis.com/queries",
            displayName: "Queries",
            consumerQuotaLimits: [
              { unit: "1/min/{project}", quotaBuckets: [{ effectiveLimit: "12000" }] },
            ],
          }],
        });
      }
      return Response.json({
        timeSeries: [{
          metric: { labels: { quota_metric: "drive.googleapis.com/queries", limit_name: "perProject" } },
          points: [{ interval: { endTime: "2026-08-28T09:05:00Z" }, value: { int64Value: "1500" } }],
        }],
      });
    });

    ctx.driveQuotaService = new DriveQuotaService(
      ctx.config,
      ctx.driveQuotaMeter,
      harness.storage,
      new DriveQuotaProbe({ projectId: "proj", key, cacheMs: 60_000, fetcher }),
    );

    const view = await quota();
    expect(view.live.configured).toBe(true);
    expect(view.live.rows![0]!.metric).toBe("drive.googleapis.com/queries");
    expect(view.live.rows![0]!.remaining).toBe(10_500);
  });
});
