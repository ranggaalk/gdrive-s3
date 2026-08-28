// Wraps the fetch used by DriveClient so every Google Drive call is counted
// exactly once, at the point the response arrives. Classification reuses
// classifyDriveResponse, so "throttled" here means the same thing it means to
// the retry policy — no second opinion about what a 403 was.

import { classifyDriveResponse } from "./errors.ts";
import type { DriveFetch } from "./client.ts";
import type { FetchLike } from "../util/fetch-like.ts";
import type { DriveCallKind, DriveQuotaMeter } from "./quota-meter.ts";

/** Error bodies are small JSON payloads; refuse to buffer anything larger. */
const MAX_ERROR_BODY_BYTES = 16 * 1024;

export function classifyCallKind(url: string): DriveCallKind {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "api";
  }
  if (parsed.pathname.startsWith("/upload/")) return "upload";
  if (parsed.searchParams.get("alt") === "media") return "download";
  return "api";
}

/**
 * Produce a fetch that reports into `meter`. `userId` is null for calls made
 * with a backup-account or service credential rather than a gateway user.
 */
export function meteredFetch(
  meter: DriveQuotaMeter,
  userId: string | null,
  inner: FetchLike = fetch,
): DriveFetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const kind = classifyCallKind(url);

    let res: Response;
    try {
      res = await inner(input, init);
    } catch (error) {
      // A transport failure never reached Google's quota, but it is still a
      // call this gateway attempted; status 0 keeps it out of the error rate
      // for HTTP responses while staying visible in the totals.
      meter.record({ userId, kind, status: 0, throttled: false, reason: null, retryAfterMs: null });
      throw error;
    }

    if (res.status < 400) {
      meter.record({
        userId,
        kind,
        status: res.status,
        throttled: false,
        reason: null,
        retryAfterMs: null,
      });
      return res;
    }

    const body = await peekErrorBody(res);
    const classified = classifyDriveResponse(res.status, body, res.headers.get("retry-after"));
    meter.record({
      userId,
      kind,
      status: res.status,
      throttled: classified.category === "rate_limit" || classified.category === "quota_exceeded",
      reason: classified.reason,
      retryAfterMs: classified.retryAfterMs,
    });
    return res;
  }) as DriveFetch;
}

/** Read an error body without consuming the response the caller still needs. */
async function peekErrorBody(res: Response): Promise<string> {
  const length = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(length) && length > MAX_ERROR_BODY_BYTES) return "";
  try {
    return await res.clone().text();
  } catch {
    return "";
  }
}
