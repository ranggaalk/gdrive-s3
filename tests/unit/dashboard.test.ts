import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardServer } from "../../apps/server/src/routes/dashboard.ts";
import { testConfig } from "../integration/_helpers.ts";

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

  test("serves dashboard routes encoded in the root query", async () => {
    const dashboard = new DashboardServer(testConfig({ serveDashboard: true, staticRoot: makeRoot() }));
    const res = await dashboard.serve(
      new Request("http://x/?page=buckets&bucket=bucket_123"),
    );
    expect(res?.status).toBe(200);
    expect(await res!.text()).toContain("DriveS3");
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
