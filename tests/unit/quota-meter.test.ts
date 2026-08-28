import { describe, expect, test } from "bun:test";
import { DriveQuotaMeter, type DriveCallRecord } from "../../apps/server/src/drive/quota-meter.ts";

const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);

function call(over: Partial<DriveCallRecord> = {}): DriveCallRecord {
  return {
    userId: "u1",
    kind: "api",
    status: 200,
    throttled: false,
    reason: null,
    retryAfterMs: null,
    ...over,
  };
}

/** A meter whose clock the test drives, so windows are exact, not timing-dependent. */
function meterAt(startMs = BASE) {
  let now = startMs;
  const meter = new DriveQuotaMeter(() => now);
  return {
    meter,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
  };
}

function windowOf(meter: DriveQuotaMeter, seconds: number) {
  const found = meter.snapshot([seconds]).windows.find((w) => w.windowSeconds === seconds);
  if (!found) throw new Error(`no window ${seconds}`);
  return found;
}

describe("DriveQuotaMeter", () => {
  test("counts calls into the windows that contain them", () => {
    const { meter, advance } = meterAt();
    for (let i = 0; i < 5; i++) meter.record(call());
    advance(30_000);
    for (let i = 0; i < 3; i++) meter.record(call());

    expect(windowOf(meter, 60).requests).toBe(8);
    expect(meter.snapshot().totalRequests).toBe(8);
  });

  test("drops calls that fall out of the window", () => {
    const { meter, advance } = meterAt();
    meter.record(call());
    advance(61_000);
    meter.record(call());

    expect(windowOf(meter, 60).requests).toBe(1);
    // Totals are lifetime counts and keep both.
    expect(meter.snapshot().totalRequests).toBe(2);
  });

  test("separates throttles from ordinary errors", () => {
    const { meter } = meterAt();
    meter.record(call({ status: 200 }));
    meter.record(call({ status: 404 }));
    meter.record(call({ status: 429, throttled: true, reason: "rateLimitExceeded", retryAfterMs: 2000 }));

    const window = windowOf(meter, 60);
    expect(window.requests).toBe(3);
    expect(window.errors).toBe(1);
    expect(window.throttled).toBe(1);
  });

  test("breaks the window down by call kind", () => {
    const { meter } = meterAt();
    meter.record(call({ kind: "api" }));
    meter.record(call({ kind: "upload" }));
    meter.record(call({ kind: "upload" }));
    meter.record(call({ kind: "download" }));

    expect(windowOf(meter, 60).byKind).toEqual({ api: 1, upload: 2, download: 1 });
  });

  test("reports a per-minute rate for windows that are not a minute long", () => {
    const { meter } = meterAt();
    // 30 calls spread over a 100s window is 18 per minute.
    for (let i = 0; i < 30; i++) meter.record(call());
    expect(windowOf(meter, 100).perMinute).toBe(18);
  });

  test("keeps the newest throttle events, newest first", () => {
    const { meter, advance } = meterAt();
    for (let i = 0; i < 3; i++) {
      meter.record(call({ status: 403, throttled: true, reason: `reason-${i}` }));
      advance(1000);
    }

    const events = meter.snapshot().recentThrottles;
    expect(events).toHaveLength(3);
    expect(events[0]!.reason).toBe("reason-2");
    expect(events[0]!.status).toBe(403);
    expect(meter.snapshot().totalThrottled).toBe(3);
  });

  test("attributes usage per user, busiest first", () => {
    const { meter } = meterAt();
    meter.record(call({ userId: "quiet" }));
    for (let i = 0; i < 4; i++) meter.record(call({ userId: "busy" }));
    meter.record(call({ userId: "busy", throttled: true, status: 429 }));

    const users = meter.snapshot().users;
    expect(users.map((u) => u.userId)).toEqual(["busy", "quiet"]);
    expect(users[0]!.requestsLastHour).toBe(5);
    expect(users[0]!.throttledLastHour).toBe(1);
  });

  test("counts anonymous calls in the totals without inventing a user", () => {
    const { meter } = meterAt();
    meter.record(call({ userId: null }));

    expect(windowOf(meter, 60).requests).toBe(1);
    expect(meter.snapshot().users).toEqual([]);
  });

  test("bounds the number of tracked users", () => {
    const { meter, advance } = meterAt();
    for (let i = 0; i < 250; i++) {
      meter.record(call({ userId: `u${i}` }));
      advance(10);
    }

    const snapshot = meter.snapshot();
    expect(snapshot.usersTracked).toBeLessThanOrEqual(200);
    // Every call still counts toward the quota-relevant totals.
    expect(snapshot.totalRequests).toBe(250);
  });

  test("a window longer than the per-second ring still sees old calls", () => {
    const { meter, advance } = meterAt();
    meter.record(call());
    advance(3 * 60 * 60 * 1000); // 3 hours
    meter.record(call());

    expect(windowOf(meter, 86_400).requests).toBe(2);
    expect(windowOf(meter, 60).requests).toBe(1);
  });
});
