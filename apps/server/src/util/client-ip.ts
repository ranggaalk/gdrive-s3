// Resolve a stable client identifier for rate-limit keys and audit logs.
// Behind a reverse proxy we honour `x-forwarded-for` (leftmost) or
// `x-real-ip`, but only when `TRUST_PROXY=true`. Direct sockets fall back to
// the Bun-provided peer address. Values are hashed before being used as a
// map key so raw IPs never appear in in-memory data structures.

import { createHash } from "node:crypto";
import type { AppConfig } from "../config.ts";

export interface HasRequestIp {
  requestIP(req: Request): { address: string } | null;
}

const UNKNOWN = "unknown";

export function rawClientIp(
  req: Request,
  server: HasRequestIp | null,
  config: AppConfig,
): string {
  if (config.trustProxy) {
    const fwd = req.headers.get("x-forwarded-for");
    if (fwd) {
      const first = fwd.split(",")[0]?.trim();
      if (first) return first;
    }
    const real = req.headers.get("x-real-ip");
    if (real) return real.trim();
  }
  const peer = server?.requestIP(req)?.address ?? null;
  return peer ?? UNKNOWN;
}

/**
 * Truncated SHA-256 of the raw client IP. Truncation trades collision
 * resistance for compactness in memory — 16 hex chars is enough to isolate
 * hostile hosts in the rate-limiter without keeping raw IPs around.
 */
export function clientIpKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export function clientIpFrom(
  req: Request,
  server: HasRequestIp | null,
  config: AppConfig,
): string {
  return clientIpKey(rawClientIp(req, server, config));
}
