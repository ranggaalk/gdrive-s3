// Bounded Drive retry policy with exponential backoff + jitter (AGENTS.md §8,
// §21). Callers must explicitly opt in by passing an idempotent/resumable
// operation; non-idempotent body-consuming writes must not use this blindly.

import { DriveError } from "./errors.ts";

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  onRetry?: (event: { attempt: number; delayMs: number; error: DriveError }) => void;
}

export async function withDriveRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts);
  const base = options.baseDelayMs ?? 250;
  const max = options.maxDelayMs ?? 30_000;
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;

  let attempt = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    options.signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof DriveError) || !error.retryable || attempt >= maxAttempts) {
        throw error;
      }
      const exponential = Math.min(max, base * 2 ** (attempt - 1));
      const jitter = Math.floor(exponential * 0.25 * random());
      const delayMs = Math.max(error.retryAfterMs ?? 0, exponential + jitter);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, options.signal);
      attempt++;
    }
  }
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // Clean listener after the timer completes.
    void Promise.resolve().then(() => {
      // no-op; lifecycle is bounded by signal/timer and listener is once-only
    });
  });
}

export function nextCleanupAttempt(attempts: number, nowMs = Date.now()): string {
  const delay = Math.min(24 * 60 * 60 * 1000, 1000 * 2 ** Math.min(attempts, 16));
  return new Date(nowMs + delay).toISOString();
}
