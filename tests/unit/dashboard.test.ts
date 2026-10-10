import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardServer } from "../../apps/server/src/routes/dashboard.ts";
import { testConfig } from "../integration/_helpers.ts";
import { isValidBucketName } from "../../apps/server/src/util/bucket-name.ts";
import { DASHBOARD_ROUTE_SEGMENTS } from "../../apps/server/src/util/dashboard-paths.ts";
import { DASHBOARD_SECTIONS } from "../../apps/web/src/lib/dashboard-route.ts";

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
  // A dashboard path the server does not know falls through to the S3 router,
  // and the browser shows an S3 XML error instead of the app. That happened to
  // /backup, /settings, and /security on a refresh, and then to /mfa, where
  // sign-in sends a session that still owes its second factor. Vite answers
  // every path with the app in development, so only production showed it;
  // these tests take the paths from their sources rather than a list kept here.
  const server = new DashboardServer(testConfig({ serveDashboard: true, staticRoot: makeRoot() }));
  const servesApp = async (path: string) => {
    const res = await server.serve(new Request(`http://localhost${path}`));
    return res?.status === 200 && (res.headers.get("content-type") ?? "").includes("text/html");
  };

  test("every section of the app survives a refresh", async () => {
    const missing: string[] = [];
    for (const section of DASHBOARD_SECTIONS) {
      if (!(await servesApp(`/${section}`))) missing.push(section);
    }
    expect(missing).toEqual([]);
  });

  test("every page the server redirects a browser to is the app", async () => {
    const dir = new URL("../../apps/server/src/routes/", import.meta.url).pathname;
    const targets = new Set<string>();
    for (const file of ["auth.ts", "backup-auth.ts", "mfa-auth.ts"]) {
      const lines = readFileSync(`${dir}${file}`, "utf8").split("\n");
      for (const line of lines.filter((l) => l.includes("Location"))) {
        for (const match of line.matchAll(/["`](\/[a-z0-9/_-]*)/g)) targets.add(match[1]!);
      }
    }
    // The scan must find the redirects it is meant to check.
    expect([...targets]).toContain("/mfa");
    const missing: string[] = [];
    for (const path of targets) {
      if (!(await servesApp(path))) missing.push(path);
    }
    expect(missing).toEqual([]);
  });

  test("no dashboard path can be taken as a bucket name", () => {
    expect([...DASHBOARD_ROUTE_SEGMENTS].filter((segment) => isValidBucketName(segment))).toEqual([]);
  });

  test("a signed S3 request for that path is still routed to S3", async () => {
    const res = await server.serve(
      new Request("http://localhost/quota", { headers: { authorization: "AWS4-HMAC-SHA256 ..." } }),
    );
    expect(res).toBeNull();
  });
});
