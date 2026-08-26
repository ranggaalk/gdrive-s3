// Audit log repository (AGENTS.md §19, §23). Append-only record of
// control-plane and data-plane actions, scoped by user for the dashboard.

import type { Database } from "bun:sqlite";
import { newAuditId, nowIso } from "../../util/ids.ts";

export interface AuditLogRow {
  id: string;
  user_id: string | null;
  credential_id: string | null;
  action: string;
  bucket_name: string | null;
  bucket_id: string | null;
  object_key: string | null;
  status_code: number | null;
  request_id: string;
  bytes_in: number | null;
  bytes_out: number | null;
  ip_hash: string | null;
  user_agent: string | null;
  detail_json: string;
  created_at: string;
}

export interface AuditEntry {
  userId: string | null;
  credentialId?: string | null;
  action: string;
  bucketName?: string | null;
  bucketId?: string | null;
  objectKey?: string | null;
  statusCode?: number | null;
  requestId: string;
  bytesIn?: number | null;
  bytesOut?: number | null;
  ipHash?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown>;
}

export type TrafficGranularity = "minute" | "hour" | "day";

export interface TrafficPoint {
  t: string;
  requests: number;
  errors: number;
  bytesIn: number;
  bytesOut: number;
}

const TRAFFIC_STRFTIME: Record<TrafficGranularity, string> = {
  minute: "%Y-%m-%dT%H:%M:00Z",
  hour: "%Y-%m-%dT%H:00:00Z",
  day: "%Y-%m-%dT00:00:00Z",
};

const TRAFFIC_STEP_MS: Record<TrafficGranularity, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

export class AuditLogsRepository {
  constructor(private readonly db: Database) {}

  record(entry: AuditEntry): void {
    this.db
      .query(
        `INSERT INTO audit_logs
           (id, user_id, credential_id, action, bucket_name, bucket_id, object_key,
            status_code, request_id, bytes_in, bytes_out, ip_hash, user_agent,
            detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newAuditId(),
        entry.userId,
        entry.credentialId ?? null,
        entry.action,
        entry.bucketName ?? null,
        entry.bucketId ?? null,
        entry.objectKey ?? null,
        entry.statusCode ?? null,
        entry.requestId,
        entry.bytesIn ?? null,
        entry.bytesOut ?? null,
        entry.ipHash ?? null,
        entry.userAgent ?? null,
        JSON.stringify(entry.detail ?? {}),
        nowIso(),
      );
  }

  /**
   * Zero-filled time series for one bucket's traffic, bucketed at
   * `granularity` from `since` through the current step. Scoped by
   * bucket_id (not bucket_name, which is only unique per owner) so it can
   * never mix in another user's differently-owned same-named bucket.
   */
  trafficSeries(bucketId: string, since: Date, granularity: TrafficGranularity): TrafficPoint[] {
    const rows = this.db
      .query<
        { bucket: string; requests: number; errors: number; bytes_in: number; bytes_out: number },
        [string, string, string]
      >(
        `SELECT
           strftime(?, created_at) AS bucket,
           COUNT(*) AS requests,
           SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors,
           COALESCE(SUM(bytes_in), 0) AS bytes_in,
           COALESCE(SUM(bytes_out), 0) AS bytes_out
         FROM audit_logs
         WHERE bucket_id = ? AND created_at >= ?
         GROUP BY bucket`,
      )
      .all(TRAFFIC_STRFTIME[granularity], bucketId, since.toISOString());
    return zeroFillTrafficPoints(rows, since, granularity);
  }

  /**
   * Same as trafficSeries, summed across every bucket in `bucketIds` — for
   * a dashboard-wide overview across all buckets a user can access. Each id
   * must already be access-checked by the caller; this method only sums.
   */
  trafficSeriesForBuckets(
    bucketIds: string[],
    since: Date,
    granularity: TrafficGranularity,
  ): TrafficPoint[] {
    if (bucketIds.length === 0) return zeroFillTrafficPoints([], since, granularity);
    const placeholders = bucketIds.map(() => "?").join(", ");
    const rows = this.db
      .query<
        { bucket: string; requests: number; errors: number; bytes_in: number; bytes_out: number },
        string[]
      >(
        `SELECT
           strftime(?, created_at) AS bucket,
           COUNT(*) AS requests,
           SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors,
           COALESCE(SUM(bytes_in), 0) AS bytes_in,
           COALESCE(SUM(bytes_out), 0) AS bytes_out
         FROM audit_logs
         WHERE bucket_id IN (${placeholders}) AND created_at >= ?
         GROUP BY bucket`,
      )
      .all(TRAFFIC_STRFTIME[granularity], ...bucketIds, since.toISOString());
    return zeroFillTrafficPoints(rows, since, granularity);
  }

  listForUser(userId: string, opts: { limit: number; before?: string }): AuditLogRow[] {
    const before = opts.before ?? "9999-12-31T23:59:59.999Z";
    return this.db
      .query<AuditLogRow, [string, string, number]>(
        `SELECT * FROM audit_logs
          WHERE user_id = ? AND created_at < ?
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(userId, before, opts.limit);
  }
}

/** Matches the strftime format for `granularity` — used as the zero-fill join key. */
function formatBucketKey(ms: number, granularity: TrafficGranularity): string {
  const iso = new Date(ms).toISOString();
  if (granularity === "minute") return `${iso.slice(0, 16)}:00Z`;
  if (granularity === "hour") return `${iso.slice(0, 13)}:00:00Z`;
  return `${iso.slice(0, 10)}T00:00:00Z`;
}

function zeroFillTrafficPoints(
  rows: Array<{ bucket: string; requests: number; errors: number; bytes_in: number; bytes_out: number }>,
  since: Date,
  granularity: TrafficGranularity,
): TrafficPoint[] {
  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  const step = TRAFFIC_STEP_MS[granularity];
  const start = Math.floor(since.getTime() / step) * step;
  const end = Math.floor(Date.now() / step) * step;
  const points: TrafficPoint[] = [];
  for (let t = start; t <= end; t += step) {
    const key = formatBucketKey(t, granularity);
    const row = byBucket.get(key);
    points.push({
      t: key,
      requests: row?.requests ?? 0,
      errors: row?.errors ?? 0,
      bytesIn: row?.bytes_in ?? 0,
      bytesOut: row?.bytes_out ?? 0,
    });
  }
  return points;
}
