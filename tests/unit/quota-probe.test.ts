import { describe, expect, test } from "bun:test";
import {
  limitScope,
  mergeQuotaRows,
  parseConsumerQuotaMetrics,
  parseQuotaUsageSeries,
  DriveQuotaProbe,
} from "../../apps/server/src/drive/quota-probe.ts";
import { parseServiceAccountKey } from "../../apps/server/src/auth/google-service-account.ts";
import { generateKeyPairSync } from "node:crypto";

// Shapes copied from live Google responses; the point of these tests is that a
// change to the parsers cannot silently start reporting the wrong quota.
const SERVICE_USAGE_BODY = {
  metrics: [
    {
      metric: "drive.googleapis.com/queries",
      displayName: "Queries",
      consumerQuotaLimits: [
        {
          unit: "1/min/{project}",
          quotaBuckets: [{ effectiveLimit: "12000", defaultLimit: "12000" }],
        },
        {
          unit: "1/min/{project}/{user}",
          quotaBuckets: [{ effectiveLimit: "12000", defaultLimit: "12000" }],
        },
      ],
    },
    {
      metric: "drive.googleapis.com/uploads",
      displayName: "Uploads",
      consumerQuotaLimits: [
        { unit: "1/min/{project}", quotaBuckets: [{ effectiveLimit: "-1" }] },
      ],
    },
  ],
};

const MONITORING_BODY = {
  timeSeries: [
    {
      metric: {
        labels: { quota_metric: "drive.googleapis.com/queries", limit_name: "defaultPerMinutePerProject" },
      },
      points: [
        { interval: { endTime: "2026-08-28T09:05:00Z" }, value: { int64Value: "4200" } },
        { interval: { endTime: "2026-08-28T09:04:00Z" }, value: { int64Value: "3900" } },
      ],
    },
    {
      metric: {
        labels: { quota_metric: "drive.googleapis.com/queries", limit_name: "defaultPerMinutePerProjectPerUser" },
      },
      points: [{ interval: { endTime: "2026-08-28T09:05:00Z" }, value: { int64Value: "700" } }],
    },
  ],
};

describe("Service Usage parsing", () => {
  test("reads the effective limit for each unit", () => {
    const limits = parseConsumerQuotaMetrics(SERVICE_USAGE_BODY);
    expect(limits).toEqual([
      { metric: "drive.googleapis.com/queries", displayName: "Queries", unit: "1/min/{project}", limit: 12000 },
      { metric: "drive.googleapis.com/queries", displayName: "Queries", unit: "1/min/{project}/{user}", limit: 12000 },
      { metric: "drive.googleapis.com/uploads", displayName: "Uploads", unit: "1/min/{project}", limit: null },
    ]);
  });

  test("an unlimited quota is null, not -1", () => {
    const uploads = parseConsumerQuotaMetrics(SERVICE_USAGE_BODY).find(
      (l) => l.metric === "drive.googleapis.com/uploads",
    );
    expect(uploads!.limit).toBeNull();
  });

  test("tolerates an empty or unexpected body", () => {
    expect(parseConsumerQuotaMetrics({})).toEqual([]);
    expect(parseConsumerQuotaMetrics({ metrics: [{ displayName: "no metric name" }] })).toEqual([]);
  });
});

describe("Cloud Monitoring parsing", () => {
  test("takes the newest point of each series", () => {
    const samples = parseQuotaUsageSeries(MONITORING_BODY);
    expect(samples).toHaveLength(2);
    expect(samples[0]).toEqual({
      metric: "drive.googleapis.com/queries",
      limitName: "defaultPerMinutePerProject",
      value: 4200,
      at: "2026-08-28T09:05:00Z",
    });
  });

  test("skips series with no usable point", () => {
    expect(
      parseQuotaUsageSeries({
        timeSeries: [
          { metric: { labels: { quota_metric: "m" } }, points: [] },
          { metric: { labels: { quota_metric: "m" } }, points: [{ interval: {} }] },
        ],
      }),
    ).toEqual([]);
  });
});

describe("merging limits with usage", () => {
  const rows = mergeQuotaRows(
    parseConsumerQuotaMetrics(SERVICE_USAGE_BODY),
    parseQuotaUsageSeries(MONITORING_BODY),
  );

  test("subtracts Google's consumption from Google's limit", () => {
    const project = rows.find((r) => r.unit === "1/min/{project}" && r.metric.endsWith("queries"))!;
    expect(project.consumed).toBe(4200);
    expect(project.remaining).toBe(12000 - 4200);
    expect(project.usedRatio).toBe(0.35);
    expect(project.consumedAt).toBe("2026-08-28T09:05:00Z");
  });

  test("keeps per-user and per-project figures apart", () => {
    const perUser = rows.find((r) => r.unit === "1/min/{project}/{user}")!;
    expect(perUser.scope).toBe("user");
    expect(perUser.consumed).toBe(700);
    expect(perUser.remaining).toBe(11_300);
  });

  test("reports an unmatched limit as unknown rather than guessing", () => {
    const uploads = rows.find((r) => r.metric.endsWith("uploads"))!;
    expect(uploads.consumed).toBeNull();
    expect(uploads.remaining).toBeNull();
    expect(uploads.usedRatio).toBeNull();
    expect(uploads.consumedAt).toBeNull();
  });

  test("remaining stays unknown when the limit is unlimited", () => {
    const merged = mergeQuotaRows(
      [{ metric: "m", displayName: "M", unit: "1/min/{project}", limit: null }],
      [{ metric: "m", limitName: "perProject", value: 5, at: "2026-08-28T09:05:00Z" }],
    );
    expect(merged[0]!.consumed).toBe(5);
    expect(merged[0]!.remaining).toBeNull();
  });

  test("picks the largest series when several share a scope", () => {
    const merged = mergeQuotaRows(
      [{ metric: "m", displayName: "M", unit: "1/min/{project}", limit: 100 }],
      [
        { metric: "m", limitName: "perProject", value: 10, at: "t1" },
        { metric: "m", limitName: "perProjectRegional", value: 40, at: "t2" },
      ],
    );
    expect(merged[0]!.consumed).toBe(40);
    expect(merged[0]!.remaining).toBe(60);
  });

  test("classifies limit units by scope", () => {
    expect(limitScope("1/min/{project}")).toBe("project");
    expect(limitScope("1/min/{project}/{user}")).toBe("user");
    expect(limitScope("1/d")).toBe("other");
  });
});

function testKey() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return parseServiceAccountKey(
    JSON.stringify({
      type: "service_account",
      project_id: "proj",
      client_email: "quota@proj.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }),
  );
}

describe("DriveQuotaProbe", () => {
  function fakeGoogle(calls: string[], overrides: { monitoringStatus?: number } = {}) {
    return async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.includes("oauth2.googleapis.com")) {
        return Response.json({ access_token: "at", expires_in: 3600 });
      }
      if (url.includes("serviceusage")) return Response.json(SERVICE_USAGE_BODY);
      if (url.includes("monitoring")) {
        if (overrides.monitoringStatus) {
          return new Response("permission denied", { status: overrides.monitoringStatus });
        }
        return Response.json(MONITORING_BODY);
      }
      throw new Error(`unexpected call ${url}`);
    };
  }

  test("reads limits and usage and joins them", async () => {
    const calls: string[] = [];
    const probe = new DriveQuotaProbe({
      projectId: "proj",
      key: testKey(),
      cacheMs: 60_000,
      fetcher: fakeGoogle(calls),
    });

    const result = await probe.read();
    expect("rows" in result).toBe(true);
    if (!("rows" in result)) return;
    expect(result.projectId).toBe("proj");
    expect(result.sampledAt).toBe("2026-08-28T09:05:00Z");
    expect(result.rows.find((r) => r.scope === "project")!.remaining).toBe(7800);
    // Asks Monitoring for a per-minute rate, matching the limit's unit.
    expect(calls.some((c) => c.includes("alignmentPeriod=60s"))).toBe(true);
    expect(calls.some((c) => c.includes("drive.googleapis.com"))).toBe(true);
  });

  test("serves the cache instead of re-reading Google", async () => {
    const calls: string[] = [];
    const probe = new DriveQuotaProbe({
      projectId: "proj",
      key: testKey(),
      cacheMs: 60_000,
      fetcher: fakeGoogle(calls),
    });

    await probe.read();
    const firstCallCount = calls.length;
    await probe.read();
    expect(calls.length).toBe(firstCallCount);
  });

  test("reports an upstream failure instead of throwing", async () => {
    const probe = new DriveQuotaProbe({
      projectId: "proj",
      key: testKey(),
      cacheMs: 60_000,
      fetcher: fakeGoogle([], { monitoringStatus: 403 }),
    });

    const result = await probe.read();
    expect("rows" in result).toBe(false);
    expect((result as { error: string }).error).toContain("Cloud Monitoring");
    expect((result as { error: string }).error).toContain("403");
  });

  test("collapses concurrent reads onto one upstream fetch", async () => {
    const calls: string[] = [];
    const probe = new DriveQuotaProbe({
      projectId: "proj",
      key: testKey(),
      cacheMs: 60_000,
      fetcher: fakeGoogle(calls),
    });

    await Promise.all([probe.read(), probe.read(), probe.read()]);
    // One token exchange, one Service Usage call, one Monitoring call.
    expect(calls).toHaveLength(3);
  });
});
