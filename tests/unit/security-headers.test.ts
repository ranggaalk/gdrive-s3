import { describe, expect, test } from "bun:test";
import {
  applySecurityHeaders,
  classifyResponseKind,
} from "../../apps/server/src/security/headers.ts";
import { hasAllowedOrigin } from "../../apps/server/src/security/origin.ts";
import { testConfig } from "../integration/_helpers.ts";

describe("applySecurityHeaders", () => {
  test("adds baseline defensive headers", () => {
    const res = new Response("ok");
    applySecurityHeaders(res, testConfig(), "health");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.headers.get("permissions-policy")).toContain("camera=()");
  });

  test("adds dashboard CSP compatible with Radix runtime styles", () => {
    const res = new Response("ok");
    applySecurityHeaders(res, testConfig(), "dashboard");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
  });

  test("sets HSTS only in production", () => {
    const dev = new Response("ok");
    applySecurityHeaders(dev, testConfig(), "api");
    expect(dev.headers.get("strict-transport-security")).toBeNull();

    const prod = new Response("ok");
    applySecurityHeaders(prod, testConfig({ isProduction: true }), "api");
    expect(prod.headers.get("strict-transport-security")).toContain("includeSubDomains");
  });

  test("does not emit a CSP on the S3 binary surface", () => {
    const res = new Response("bytes");
    applySecurityHeaders(res, testConfig(), "s3");
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  test("hardens public share responses for cross-origin direct use", () => {
    const res = new Response("bytes");
    applySecurityHeaders(res, testConfig(), "public-share");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });
});

describe("response kind", () => {
  test("classifies fixed control-plane paths before S3", () => {
    expect(classifyResponseKind("/health/live", false)).toBe("health");
    expect(classifyResponseKind("/api/me", false)).toBe("api");
    expect(classifyResponseKind("/auth/logout", false)).toBe("auth");
    expect(classifyResponseKind("/__drives3_share/token", false)).toBe("public-share");
    expect(classifyResponseKind("/bucket/key", false)).toBe("s3");
    expect(classifyResponseKind("/assets/app.js", true)).toBe("dashboard");
  });
});

describe("hasAllowedOrigin", () => {
  const config = testConfig({ appOrigin: "https://app.example.test" });

  test("allows safe methods and absent Origin", () => {
    expect(hasAllowedOrigin(new Request("https://app.example.test/api/me"), config)).toBe(true);
    expect(
      hasAllowedOrigin(
        new Request("https://app.example.test/api/x", { method: "POST" }),
        config,
      ),
    ).toBe(true);
  });

  test("allows exact same origin and rejects mismatch", () => {
    const same = new Request("https://app.example.test/api/x", {
      method: "POST",
      headers: { origin: "https://app.example.test" },
    });
    const other = new Request("https://app.example.test/api/x", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(hasAllowedOrigin(same, config)).toBe(true);
    expect(hasAllowedOrigin(other, config)).toBe(false);
  });
});
