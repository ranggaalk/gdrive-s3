import { describe, expect, test } from "bun:test";
import { classifyCallKind, meteredFetch } from "../../apps/server/src/drive/metered-fetch.ts";
import { DriveQuotaMeter } from "../../apps/server/src/drive/quota-meter.ts";

describe("classifyCallKind", () => {
  test("tells uploads, downloads, and metadata calls apart", () => {
    expect(classifyCallKind("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart"))
      .toBe("upload");
    expect(classifyCallKind("https://www.googleapis.com/drive/v3/files/abc?alt=media")).toBe("download");
    expect(classifyCallKind("https://www.googleapis.com/drive/v3/files?q=trashed%3Dfalse")).toBe("api");
  });

  test("a resumable session URL still counts as an upload", () => {
    expect(
      classifyCallKind("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=x"),
    ).toBe("upload");
  });

  test("an unparseable URL falls back to a metadata call rather than throwing", () => {
    expect(classifyCallKind("not a url")).toBe("api");
  });
});

describe("meteredFetch", () => {
  const URL_API = "https://www.googleapis.com/drive/v3/files";

  test("counts a successful call", async () => {
    const meter = new DriveQuotaMeter();
    const fetcher = meteredFetch(meter, "u1", async () => Response.json({ files: [] }));

    await fetcher(URL_API);
    const snapshot = meter.snapshot();
    expect(snapshot.totalRequests).toBe(1);
    expect(snapshot.totalThrottled).toBe(0);
    expect(snapshot.users[0]!.userId).toBe("u1");
  });

  test("recognises a rate-limit 403 as a throttle and keeps Retry-After", async () => {
    const meter = new DriveQuotaMeter();
    const fetcher = meteredFetch(meter, "u1", async () =>
      new Response(JSON.stringify({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }), {
        status: 403,
        headers: { "retry-after": "7" },
      }),
    );

    await fetcher(URL_API);
    const event = meter.snapshot().recentThrottles[0]!;
    expect(event.reason).toBe("userRateLimitExceeded");
    expect(event.retryAfterMs).toBe(7000);
    expect(meter.snapshot().totalThrottled).toBe(1);
  });

  test("an ordinary 404 is an error, not a throttle", async () => {
    const meter = new DriveQuotaMeter();
    const fetcher = meteredFetch(meter, "u1", async () => new Response("{}", { status: 404 }));

    await fetcher(URL_API);
    expect(meter.snapshot().totalThrottled).toBe(0);
    expect(meter.snapshot().windows[0]!.errors).toBe(1);
  });

  test("leaves the response body readable for the caller", async () => {
    const meter = new DriveQuotaMeter();
    const fetcher = meteredFetch(meter, "u1", async () =>
      new Response(JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }] } }), {
        status: 403,
      }),
    );

    // The Drive client reads the error body itself; metering must not consume it.
    const res = await fetcher(URL_API);
    expect(await res.text()).toContain("rateLimitExceeded");
  });

  test("counts a transport failure and rethrows it", async () => {
    const meter = new DriveQuotaMeter();
    const boom = new Error("socket hang up");
    const fetcher = meteredFetch(meter, "u1", async () => {
      throw boom;
    });

    await expect(fetcher(URL_API)).rejects.toThrow("socket hang up");
    expect(meter.snapshot().totalRequests).toBe(1);
  });

  test("does not buffer an oversized error body", async () => {
    const meter = new DriveQuotaMeter();
    const fetcher = meteredFetch(meter, "u1", async () =>
      new Response("x".repeat(64), {
        status: 500,
        headers: { "content-length": String(1024 * 1024) },
      }),
    );

    await fetcher(URL_API);
    // Still counted, just without a reason parsed out of the skipped body.
    expect(meter.snapshot().totalRequests).toBe(1);
    expect(meter.snapshot().windows[0]!.errors).toBe(1);
  });
});
