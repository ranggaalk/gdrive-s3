// Shared range->granularity mapping for traffic chart endpoints
// (api-buckets.ts bucket-scoped, api-traffic.ts dashboard-wide overview).

import type { TrafficGranularity } from "../db/repositories/audit-logs.ts";

export type TrafficRange = "1h" | "24h" | "7d";

interface TrafficWindow {
  windowMs: number;
  granularity: TrafficGranularity;
}

const TRAFFIC_WINDOWS: Record<TrafficRange, TrafficWindow> = {
  "1h": { windowMs: 60 * 60_000, granularity: "minute" },
  "24h": { windowMs: 24 * 60 * 60_000, granularity: "hour" },
  "7d": { windowMs: 7 * 24 * 60 * 60_000, granularity: "day" },
};

export function resolveTrafficWindow(range: string): TrafficWindow | null {
  return Object.prototype.hasOwnProperty.call(TRAFFIC_WINDOWS, range)
    ? TRAFFIC_WINDOWS[range as TrafficRange]
    : null;
}
