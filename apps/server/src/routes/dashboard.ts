// Production dashboard static serving. The S3 data plane owns every path not
// explicitly reserved here. `/__drives3_assets/*` uses an underscore, which
// cannot be a valid S3 bucket name, so it cannot collide with path-style S3.
// Authenticated SigV4 requests always fall through to S3, including GET `/`.

import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { AppConfig } from "../config.ts";

const ASSET_PREFIX = "/__drives3_assets/";
const ASSET_PATH = /^\/__drives3_assets\/[A-Za-z0-9._-]+$/;

// Client-side dashboard routes (apps/web/src/lib/dashboard-route.ts). These
// top-level segments are reserved bucket names (util/bucket-name.ts) so they
// can never collide with a real S3 path-style request.
const DASHBOARD_ROUTE_SEGMENTS = new Set([
  "overview",
  "buckets",
  "credentials",
  "activity",
  "documentation",
  "backup",
  "quota",
  "settings",
  "security",
]);

function isDashboardRoutePath(path: string): boolean {
  const first = path.split("/").filter(Boolean)[0];
  return first !== undefined && DASHBOARD_ROUTE_SEGMENTS.has(first);
}

export class DashboardServer {
  private readonly root: string;
  private readonly indexHtml: Uint8Array | null;

  constructor(private readonly config: AppConfig) {
    this.root = resolve(config.staticRoot);
    const indexPath = resolve(this.root, "index.html");
    this.indexHtml = config.serveDashboard && existsSync(indexPath)
      ? new Uint8Array(readFileSync(indexPath))
      : null;
  }

  async serve(req: Request): Promise<Response | null> {
    if (!this.config.serveDashboard || !this.indexHtml) return null;
    if (req.method !== "GET" && req.method !== "HEAD") return null;
    if (looksLikeS3Request(req)) return null;
    const path = new URL(req.url).pathname;

    if (path === "/" || path === "/index.html" || isDashboardRoutePath(path)) {
      return new Response(req.method === "HEAD" ? null : this.indexHtml.slice(), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }
    if (path === "/favicon.ico") {
      return this.serveFile("favicon.ico", req.method === "HEAD", "public, max-age=86400");
    }
    if (ASSET_PATH.test(path)) {
      return this.serveFile(path.slice(1), req.method === "HEAD", "public, max-age=31536000, immutable");
    }
    return null;
  }

  private async serveFile(
    relativePath: string,
    headOnly: boolean,
    cacheControl: string,
  ): Promise<Response | null> {
    const path = assertUnder(this.root, resolve(this.root, relativePath));
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const headers = {
      "Content-Type": contentType(path),
      "Content-Length": String(file.size),
      "Cache-Control": cacheControl,
    };
    return new Response(headOnly ? null : file.stream(), { status: 200, headers });
  }
}

function looksLikeS3Request(req: Request): boolean {
  const url = new URL(req.url);
  return (
    req.headers.has("authorization") ||
    req.headers.has("x-amz-date") ||
    req.headers.has("x-amz-content-sha256") ||
    url.searchParams.has("X-Amz-Signature") ||
    url.searchParams.has("X-Amz-Algorithm")
  );
}

function assertUnder(root: string, target: string): string {
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("dashboard path escapes static root");
  }
  return target;
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

export { ASSET_PREFIX };
