import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardServer } from "../../apps/server/src/routes/dashboard.ts";
import { testConfig } from "../integration/_helpers.ts";
import { isValidBucketName } from "../../apps/server/src/util/bucket-name.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "drives3-web-"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>DriveS3</title>");
  mkdirSync(join(root, "__drives3_assets"), { recursive: true });
  writeFileSync(join(root, "__drives3_assets", "app.js"), "console.log('hi')");
  writeFileSync(join(root, "favicon.ico"), Buffer.from([0, 1, 2, 3]));
  roots.push(root);
  return root;
}

describe("DashboardServer", () => {
  test("returns index.html for GET /", async () => {
    const dashboard = new DashboardServer(testConfig({ serveDashboard: true, staticRoot: makeRoot() }));
    const res = await dashboard.serve(new Request("http://x/"));
    expect(res?.status).toBe(200);
    expect(res?.headers.get("cache-control")).toBe("no-cache");
    expect(await res!.text()).toContain("DriveS3");
  });

  test("serves dashboard section and bucket detail paths", async () => {
    const dashboard = new DashboardServer(testConfig({ serveDashboard: true, staticRoot: makeRoot() }));
    for (const path of ["/buckets", "/buckets/bucket_123", "/activity", "/credentials", "/documentation"]) {
      const res = await dashboard.serve(new Request(`http://x${path}`));
      expect(res?.status).toBe(200);
      expect(await res!.text()).toContain("DriveS3");
    }
  });

  test("serves hashed assets with immutable caching", async () => {
    const dashboard = new DashboardServer(testConfig({ serveDashboard: true, staticRoot: makeRoot() }));
    const res = await dashboard.serve(new Request("http://x/__drives3_assets/app.js"));
    expect(res?.status).toBe(200);
    expect(res?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res?.headers.get("content-type")).toContain("javascript");
  });

  test("falls through when an S3 auth header is present", async () => {
    const dashboard = new DashboardServer(testConfig({ serveDashboard: true, staticRoot: makeRoot() }));
    const s3Auth = new Request("http://x/", {
      headers: { authorization: "AWS4-HMAC-SHA256 Signature=00" },
    });
    expect(await dashboard.serve(s3Auth)).toBeNull();
  });

  test("returns null when serving is disabled", async () => {
    const dashboard = new DashboardServer(testConfig({ serveDashboard: false, staticRoot: makeRoot() }));
    expect(await dashboard.serve(new Request("http://x/"))).toBeNull();
  });

  test("does not serve non-asset paths from within the root", async () => {
    const dashboard = new DashboardServer(testConfig({ serveDashboard: true, staticRoot: makeRoot() }));
    expect(await dashboard.serve(new Request("http://x/other.js"))).toBeNull();
    expect(await dashboard.serve(new Request("http://x/assets/app.js"))).toBeNull();
    expect(
      await dashboard.serve(new Request("http://x/__drives3_assets/nested/app.js")),
    ).toBeNull();
  });
});

describe("dashboard SPA routes", () => {
  // Every client-side section must survive a hard refresh. When a segment is
  // missing here the request falls through to the S3 router and 404s, which is
  // what /backup, /settings, and /security used to do.
  const server = new DashboardServer(testConfig({ serveDashboard: true, staticRoot: makeRoot() }));

  test.each([
    "/overview",
    "/buckets",
    "/credentials",
    "/activity",
    "/documentation",
    "/backup",
    "/quota",
    "/settings",
    "/security",
  ])("serves the dashboard on a refresh of %s", async (path) => {
    const res = await server.serve(new Request(`http://localhost${path}`));
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toContain("text/html");
  });

  test("a dashboard route segment cannot be taken as a bucket name", () => {
    for (const path of ["/overview", "/buckets", "/backup", "/quota", "/settings", "/security"]) {
      expect(isValidBucketName(path.slice(1))).toBe(false);
    }
  });

  test("a signed S3 request for that path is still routed to S3", async () => {
    const res = await server.serve(
      new Request("http://localhost/quota", { headers: { authorization: "AWS4-HMAC-SHA256 ..." } }),
    );
    expect(res).toBeNull();
  });
});
