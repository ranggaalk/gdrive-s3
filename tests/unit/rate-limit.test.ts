import { describe, expect, test } from "bun:test";
import { KeyedRateLimiter, TokenBucket } from "../../apps/server/src/security/rate-limit.ts";
import { RateLimits, retryAfterSeconds } from "../../apps/server/src/security/rate-limits.ts";
import { clientIpFrom, rawClientIp } from "../../apps/server/src/util/client-ip.ts";
import { testConfig } from "../integration/_helpers.ts";

describe("TokenBucket", () => {
  test("allows a burst up to capacity", () => {
    const bucket = new TokenBucket(2, 1, 0);
    expect(bucket.take(0)).toMatchObject({ allowed: true, remaining: 1 });
    expect(bucket.take(0)).toMatchObject({ allowed: true, remaining: 0 });
    expect(bucket.take(0)).toMatchObject({ allowed: false, retryAfterMs: 1000 });
  });

  test("refills lazily without a timer", () => {
    const bucket = new TokenBucket(1, 2, 0);
    expect(bucket.take(0).allowed).toBe(true);
    expect(bucket.take(250)).toMatchObject({ allowed: false, retryAfterMs: 250 });
    expect(bucket.take(500).allowed).toBe(true);
  });

  test("does not refill past capacity", () => {
    const bucket = new TokenBucket(2, 10, 0);
    expect(bucket.peek(60_000)).toBe(2);
  });
});

describe("KeyedRateLimiter", () => {
  test("isolates keys", () => {
    const limiter = new KeyedRateLimiter({ capacity: 1, refillPerSecond: 1, maxKeys: 10 });
    expect(limiter.take("a", 0).allowed).toBe(true);
    expect(limiter.take("a", 0).allowed).toBe(false);
    expect(limiter.take("b", 0).allowed).toBe(true);
  });

  test("evicts least recently used keys at the bound", () => {
    const limiter = new KeyedRateLimiter({ capacity: 1, refillPerSecond: 1, maxKeys: 2 });
    limiter.take("a", 0);
    limiter.take("b", 0);
    limiter.take("a", 0); // refresh a; b is now oldest
    limiter.take("c", 0);
    expect(limiter.size()).toBe(2);
    expect(limiter.take("b", 0).allowed).toBe(true); // fresh bucket after eviction
  });
});

describe("RateLimits", () => {
  test("honors disabled configuration", () => {
    const limits = new RateLimits(
      testConfig({ rateLimit: { ...testConfig().rateLimit, enabled: false } }),
    );
    for (let i = 0; i < 100; i++) {
      expect(limits.take("login", "one", 0).allowed).toBe(true);
    }
  });

  test("formats Retry-After as whole seconds", () => {
    expect(retryAfterSeconds({ allowed: false, retryAfterMs: 1, remaining: 0 })).toBe("1");
    expect(retryAfterSeconds({ allowed: false, retryAfterMs: 1500, remaining: 0 })).toBe("2");
  });
});

describe("client IP resolution", () => {
  test("ignores forwarded headers unless TRUST_PROXY is true", () => {
    const req = new Request("http://x", { headers: { "x-forwarded-for": "203.0.113.5" } });
    const server = { requestIP: () => ({ address: "127.0.0.1" }) };
    expect(rawClientIp(req, server, testConfig())).toBe("127.0.0.1");
    expect(rawClientIp(req, server, testConfig({ trustProxy: true }))).toBe("203.0.113.5");
  });

  test("hashes resolved IP into an opaque stable key", () => {
    const req = new Request("http://x");
    const server = { requestIP: () => ({ address: "127.0.0.1" }) };
    const a = clientIpFrom(req, server, testConfig());
    const b = clientIpFrom(req, server, testConfig());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toContain("127");
  });
});
