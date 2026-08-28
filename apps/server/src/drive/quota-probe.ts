// Live Drive API quota, read from Google rather than inferred locally.
//
// Drive API responses carry no rate-limit headers, so there is no way to learn
// the remaining quota from a Drive call itself. Two Google Cloud APIs do know,
// for the project that owns the OAuth client:
//
//   Service Usage      the configured limit  (consumerQuotaMetrics)
//   Cloud Monitoring   the consumed rate     (serviceruntime.../quota/rate/net_usage)
//
// remaining = limit - consumed, with both numbers supplied by Google. Where
// Monitoring reports nothing for a limit, consumed/remaining stay null: an
// unknown figure is reported as unknown, never estimated.
//
// Quota metrics lag by a few minutes on Google's side, so every row carries the
// timestamp of the sample it came from.

import {
  fetchServiceAccountToken,
  QUOTA_PROBE_SCOPE,
  type ServiceAccountKey,
  type ServiceAccountToken,
} from "../auth/google-service-account.ts";
import type { FetchLike } from "../util/fetch-like.ts";

const SERVICE = "drive.googleapis.com";
const SERVICE_USAGE_BASE = "https://serviceusage.googleapis.com/v1beta1";
const MONITORING_BASE = "https://monitoring.googleapis.com/v3";
const NET_USAGE_METRIC = "serviceruntime.googleapis.com/quota/rate/net_usage";
/** Quota samples land late; look back far enough to catch the newest one. */
const USAGE_LOOKBACK_MS = 20 * 60 * 1000;

export interface QuotaLimit {
  /** e.g. "drive.googleapis.com/queries" */
  metric: string;
  displayName: string;
  /** e.g. "1/min/{project}" or "1/min/{project}/{user}" */
  unit: string;
  /** null when Google reports the limit as unlimited. */
  limit: number | null;
}

export interface QuotaUsageSample {
  metric: string;
  limitName: string;
  value: number;
  /** End of the sampled minute, as Google timestamped it. */
  at: string;
}

export interface QuotaRow extends QuotaLimit {
  /** Requests Google counted in the most recent sampled minute. */
  consumed: number | null;
  remaining: number | null;
  usedRatio: number | null;
  /** Timestamp of the sample `consumed` came from, or null when unmatched. */
  consumedAt: string | null;
  scope: "project" | "user" | "other";
}

export interface LiveQuota {
  configured: true;
  projectId: string;
  rows: QuotaRow[];
  /** Newest sample timestamp across all rows; null when Monitoring was empty. */
  sampledAt: string | null;
  /**
   * Why consumption is missing, when the limits were readable but Monitoring
   * was not. Cloud Monitoring requires billing on the project, so this is the
   * normal state for a project without it; the limits are still worth showing,
   * with consumption reported as unknown.
   */
  usageError: string | null;
  fetchedAt: string;
}

export interface LiveQuotaUnavailable {
  configured: boolean;
  error: string;
}

export type LiveQuotaResult = LiveQuota | LiveQuotaUnavailable;

export function isLiveQuota(result: LiveQuotaResult): result is LiveQuota {
  return (result as LiveQuota).rows !== undefined;
}

// ---------------------------------------------------------------------------
// Pure parsers. Kept separate from I/O so the response shapes can be tested
// against recorded Google payloads.
// ---------------------------------------------------------------------------

interface ServiceUsageResponse {
  metrics?: Array<{
    metric?: string;
    displayName?: string;
    consumerQuotaLimits?: Array<{
      unit?: string;
      quotaBuckets?: Array<{ effectiveLimit?: string; defaultLimit?: string }>;
    }>;
  }>;
}

export function parseConsumerQuotaMetrics(body: unknown): QuotaLimit[] {
  const response = body as ServiceUsageResponse;
  const limits: QuotaLimit[] = [];

  for (const metric of response.metrics ?? []) {
    const name = metric.metric;
    if (!name) continue;
    for (const limit of metric.consumerQuotaLimits ?? []) {
      const unit = limit.unit;
      if (!unit) continue;
      // The first bucket is the project-wide default; region overrides follow
      // it and do not apply to Drive, which is a global service.
      const bucket = limit.quotaBuckets?.[0];
      const raw = bucket?.effectiveLimit ?? bucket?.defaultLimit ?? null;
      limits.push({
        metric: name,
        displayName: metric.displayName ?? name,
        unit,
        // Google encodes "no limit" as -1.
        limit: raw === null || raw === "-1" ? null : toFiniteNumber(raw),
      });
    }
  }

  limits.sort((a, b) => a.metric.localeCompare(b.metric) || a.unit.localeCompare(b.unit));
  return limits;
}

interface MonitoringResponse {
  timeSeries?: Array<{
    metric?: { labels?: Record<string, string> };
    points?: Array<{
      interval?: { endTime?: string };
      value?: { int64Value?: string | number; doubleValue?: number };
    }>;
  }>;
}

export function parseQuotaUsageSeries(body: unknown): QuotaUsageSample[] {
  const response = body as MonitoringResponse;
  const samples: QuotaUsageSample[] = [];

  for (const series of response.timeSeries ?? []) {
    const metric = series.metric?.labels?.quota_metric;
    if (!metric) continue;
    // Points arrive newest-first; the newest complete sample is the useful one.
    const point = series.points?.[0];
    const at = point?.interval?.endTime;
    if (!point || !at) continue;
    const value = point.value?.int64Value ?? point.value?.doubleValue;
    if (value === undefined) continue;
    samples.push({
      metric,
      limitName: series.metric?.labels?.limit_name ?? "",
      value: toFiniteNumber(value) ?? 0,
      at,
    });
  }

  return samples;
}

export function limitScope(unit: string): QuotaRow["scope"] {
  if (unit.includes("{user}")) return "user";
  if (unit.includes("{project}")) return "project";
  return "other";
}

/**
 * Join configured limits to observed consumption.
 *
 * Service Usage names a limit by its unit ("1/min/{project}/{user}") while
 * Monitoring names it by its limit_name label ("defaultPerMinutePerProject").
 * The two vocabularies do not line up textually, so per-user and per-project
 * series are told apart by whether limit_name mentions a user. A limit with no
 * matching series keeps consumed=null rather than borrowing another row's
 * number.
 */
export function mergeQuotaRows(limits: QuotaLimit[], samples: QuotaUsageSample[]): QuotaRow[] {
  return limits.map((limit) => {
    const scope = limitScope(limit.unit);
    const matches = samples.filter(
      (sample) => sample.metric === limit.metric && sampleScope(sample.limitName) === scope,
    );
    // Several series can share a scope (one per region or per user); the
    // binding constraint is the largest, so report that one.
    const best = matches.reduce<QuotaUsageSample | null>(
      (acc, sample) => (acc === null || sample.value > acc.value ? sample : acc),
      null,
    );

    const consumed = best?.value ?? null;
    const remaining =
      consumed !== null && limit.limit !== null ? Math.max(0, limit.limit - consumed) : null;
    const usedRatio =
      consumed !== null && limit.limit !== null && limit.limit > 0
        ? Math.round((consumed / limit.limit) * 10_000) / 10_000
        : null;

    return {
      ...limit,
      scope,
      consumed,
      remaining,
      usedRatio,
      consumedAt: best?.at ?? null,
    };
  });
}

function sampleScope(limitName: string): QuotaRow["scope"] {
  if (/user/i.test(limitName)) return "user";
  if (/project/i.test(limitName)) return "project";
  return "other";
}

function toFiniteNumber(value: string | number): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Network layer
// ---------------------------------------------------------------------------

export interface QuotaProbeOptions {
  projectId: string;
  key: ServiceAccountKey;
  cacheMs: number;
  fetcher?: FetchLike;
  now?: () => number;
}

export class DriveQuotaProbe {
  private token: ServiceAccountToken | null = null;
  private cached: { at: number; result: LiveQuotaResult } | null = null;
  private inFlight: Promise<LiveQuotaResult> | null = null;

  constructor(private readonly options: QuotaProbeOptions) {}

  /**
   * Read the live quota, at most once per cache window. Cloud Monitoring has
   * quotas of its own, and its numbers only move once a minute, so probing it
   * per dashboard render would be both wasteful and pointless.
   */
  async read(signal?: AbortSignal): Promise<LiveQuotaResult> {
    const now = this.options.now ?? Date.now;
    if (this.cached && now() - this.cached.at < this.options.cacheMs) {
      return this.cached.result;
    }
    // Collapse concurrent dashboard loads onto one upstream read.
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.load(signal)
      .then((result) => {
        this.cached = { at: now(), result };
        return result;
      })
      .catch((error): LiveQuotaResult => {
        const result: LiveQuotaUnavailable = {
          configured: true,
          error: error instanceof Error ? error.message : String(error),
        };
        // Cache failures too, so a broken IAM binding cannot turn every
        // dashboard load into two failing upstream calls.
        this.cached = { at: now(), result };
        return result;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  private async load(signal?: AbortSignal): Promise<LiveQuota> {
    const accessToken = await this.accessToken(signal);
    // The limits are the half that always works; Monitoring needs billing on
    // the project, so let it fail on its own without taking the limits down
    // with it. Rows then carry consumed=null, which the UI already renders as
    // unknown rather than as a guess.
    const [limits, usage] = await Promise.all([
      this.readLimits(accessToken, signal),
      this.readUsage(accessToken, signal).then(
        (samples) => ({ samples, error: null as string | null }),
        (error: unknown) => ({
          samples: [] as QuotaUsageSample[],
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    ]);

    const rows = mergeQuotaRows(limits, usage.samples);
    const sampledAt = rows.reduce<string | null>(
      (newest, row) =>
        row.consumedAt !== null && (newest === null || row.consumedAt > newest)
          ? row.consumedAt
          : newest,
      null,
    );

    return {
      configured: true,
      projectId: this.options.projectId,
      rows,
      sampledAt,
      usageError: usage.error,
      fetchedAt: new Date((this.options.now ?? Date.now)()).toISOString(),
    };
  }

  private async accessToken(signal?: AbortSignal): Promise<string> {
    const now = this.options.now ?? Date.now;
    if (this.token && this.token.expiresAtMs - 60_000 > now()) return this.token.accessToken;
    this.token = await fetchServiceAccountToken(
      this.options.key,
      QUOTA_PROBE_SCOPE,
      this.options.fetcher ?? fetch,
      signal,
    );
    return this.token.accessToken;
  }

  private async readLimits(accessToken: string, signal?: AbortSignal): Promise<QuotaLimit[]> {
    const url = new URL(
      `${SERVICE_USAGE_BASE}/projects/${encodeURIComponent(this.options.projectId)}` +
        `/services/${SERVICE}/consumerQuotaMetrics`,
    );
    url.searchParams.set("view", "BASIC");
    url.searchParams.set("pageSize", "100");
    return parseConsumerQuotaMetrics(await this.get(url, accessToken, "Service Usage", signal));
  }

  private async readUsage(accessToken: string, signal?: AbortSignal): Promise<QuotaUsageSample[]> {
    const now = (this.options.now ?? Date.now)();
    const url = new URL(
      `${MONITORING_BASE}/projects/${encodeURIComponent(this.options.projectId)}/timeSeries`,
    );
    url.searchParams.set(
      "filter",
      `metric.type="${NET_USAGE_METRIC}" AND resource.label."service"="${SERVICE}"`,
    );
    url.searchParams.set("interval.startTime", new Date(now - USAGE_LOOKBACK_MS).toISOString());
    url.searchParams.set("interval.endTime", new Date(now).toISOString());
    // net_usage is a DELTA metric: summing a 60s window yields requests/minute,
    // the same unit the Service Usage limits are expressed in.
    url.searchParams.set("aggregation.alignmentPeriod", "60s");
    url.searchParams.set("aggregation.perSeriesAligner", "ALIGN_SUM");
    url.searchParams.set("aggregation.crossSeriesReducer", "REDUCE_SUM");
    url.searchParams.append("aggregation.groupByFields", 'metric.label."quota_metric"');
    url.searchParams.append("aggregation.groupByFields", 'metric.label."limit_name"');
    url.searchParams.set("view", "FULL");
    return parseQuotaUsageSeries(await this.get(url, accessToken, "Cloud Monitoring", signal));
  }

  private async get(
    url: URL,
    accessToken: string,
    label: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const fetcher = this.options.fetcher ?? fetch;
    const res = await fetcher(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal,
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new Error(`${label} request failed (${res.status}): ${text}`);
    }
    return await res.json();
  }
}
