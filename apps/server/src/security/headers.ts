// Response-hardening headers (AGENTS.md §20). All routes go through
// `applySecurityHeaders`; the surface differs by response kind:
//
// - dashboard: strict CSP + framing/opener + HSTS in production
// - api: same-origin CSP variants, no HSTS on http
// - s3: minimal set (no CSP: S3 clients do not render bytes)
// - health/auth: baseline defensive set

import type { AppConfig } from "../config.ts";

export type ResponseKind = "dashboard" | "api" | "s3" | "auth" | "health" | "public-share";

const BASELINE: Array<[string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "same-origin"],
  ["X-Frame-Options", "DENY"],
  ["Cross-Origin-Opener-Policy", "same-origin"],
  ["Cross-Origin-Resource-Policy", "same-origin"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()"],
];

// Tailwind emits static stylesheets, while Radix dialog primitives manage
// focus/scroll-lock state with runtime styles. Scripts remain self-only.
const DASHBOARD_CSP =
  "default-src 'self'; " +
  "base-uri 'none'; " +
  "frame-ancestors 'none'; " +
  "form-action 'self'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; " +
  "script-src 'self'; " +
  "connect-src 'self'";

const API_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export function applySecurityHeaders(
  res: Response,
  config: AppConfig,
  kind: ResponseKind,
): void {
  for (const [name, value] of BASELINE) {
    if (!res.headers.has(name)) res.headers.set(name, value);
  }

  if (kind === "dashboard") {
    if (!res.headers.has("Content-Security-Policy")) {
      res.headers.set("Content-Security-Policy", DASHBOARD_CSP);
    }
  } else if (kind === "api" || kind === "auth") {
    if (!res.headers.has("Content-Security-Policy")) {
      res.headers.set("Content-Security-Policy", API_CSP);
    }
  } else if (kind === "public-share") {
    res.headers.set("Cache-Control", "private, no-store");
    res.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    if (!res.headers.has("Content-Security-Policy")) {
      res.headers.set(
        "Content-Security-Policy",
        "default-src 'none'; sandbox; media-src 'self'; img-src 'self'",
      );
    }
  }
  // Health & S3 skip CSP entirely: health responses are already tiny JSON,
  // S3 responses are XML/binary consumed by SDKs that ignore browser headers.

  if (config.isProduction) {
    if (!res.headers.has("Strict-Transport-Security")) {
      res.headers.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    }
  }
}

export function classifyResponseKind(path: string, isDashboardAsset: boolean): ResponseKind {
  if (path === "/health/live" || path === "/health/ready") return "health";
  if (path.startsWith("/auth/")) return "auth";
  if (path.startsWith("/api/")) return "api";
  if (path.startsWith("/__drives3_share/")) return "public-share";
  if (isDashboardAsset) return "dashboard";
  return "s3";
}
