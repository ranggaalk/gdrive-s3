// Typed Drive error model (AGENTS.md §21). The Drive client raises DriveError
// so retry/reconciliation code can classify failures without parsing prose.

export type DriveErrorCategory =
  | "rate_limit"
  | "quota_exceeded"
  | "server_error"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_request"
  | "network"
  | "aborted"
  | "other";

export class DriveError extends Error {
  public readonly status: number;
  public readonly category: DriveErrorCategory;
  public readonly reason: string | null;
  public readonly retryAfterMs: number | null;
  public readonly retryable: boolean;
  public readonly tokenRevoked: boolean;

  constructor(input: {
    status: number;
    category: DriveErrorCategory;
    message: string;
    reason?: string | null;
    retryAfterMs?: number | null;
    retryable?: boolean;
    tokenRevoked?: boolean;
  }) {
    super(input.message);
    this.name = "DriveError";
    this.status = input.status;
    this.category = input.category;
    this.reason = input.reason ?? null;
    this.retryAfterMs = input.retryAfterMs ?? null;
    this.retryable = input.retryable ?? false;
    this.tokenRevoked = input.tokenRevoked ?? false;
  }
}

const RATE_LIMIT_REASONS = /rateLimitExceeded|userRateLimitExceeded/;
const QUOTA_REASONS = /storageQuotaExceeded|quotaExceeded/;

export function classifyDriveResponse(
  status: number,
  bodyText: string,
  retryAfterHeader: string | null,
): DriveError {
  const reason = extractReason(bodyText);
  const retryAfterMs = parseRetryAfter(retryAfterHeader);

  if (status === 401) {
    return new DriveError({
      status,
      category: "unauthorized",
      message: "Drive request unauthorized",
      reason,
      tokenRevoked: true,
    });
  }
  if (status === 403 && reason && RATE_LIMIT_REASONS.test(reason)) {
    return new DriveError({
      status,
      category: "rate_limit",
      message: `Drive rate limited (${reason})`,
      reason,
      retryAfterMs,
      retryable: true,
    });
  }
  if (status === 403 && reason && QUOTA_REASONS.test(reason)) {
    return new DriveError({
      status,
      category: "quota_exceeded",
      message: `Drive quota exceeded (${reason})`,
      reason,
    });
  }
  if (status === 403) {
    return new DriveError({ status, category: "forbidden", message: "Drive forbidden", reason });
  }
  if (status === 404) {
    return new DriveError({ status, category: "not_found", message: "Drive resource not found", reason });
  }
  if (status === 409) {
    return new DriveError({ status, category: "conflict", message: "Drive conflict", reason });
  }
  if (status === 429) {
    return new DriveError({
      status,
      category: "rate_limit",
      message: "Drive throttled",
      reason,
      retryAfterMs,
      retryable: true,
    });
  }
  if (status >= 500) {
    return new DriveError({
      status,
      category: "server_error",
      message: `Drive server error (${status})`,
      reason,
      retryAfterMs,
      retryable: true,
    });
  }
  if (status >= 400) {
    return new DriveError({
      status,
      category: "invalid_request",
      message: `Drive request failed (${status})`,
      reason,
    });
  }
  return new DriveError({ status, category: "other", message: `Drive unexpected ${status}`, reason });
}

/**
 * Parse a Retry-After header (delay-seconds or HTTP-date) into milliseconds.
 * Returns null when the header is missing or unparseable.
 */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber >= 0) return Math.round(asNumber * 1000);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  const diff = parsed - Date.now();
  return diff > 0 ? diff : 0;
}

function extractReason(bodyText: string): string | null {
  if (!bodyText) return null;
  const match = /"reason"\s*:\s*"([^"]+)"/.exec(bodyText);
  return match ? match[1]! : null;
}
