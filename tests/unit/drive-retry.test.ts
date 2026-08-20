import { describe, expect, test } from "bun:test";
import { classifyDriveResponse, DriveError, parseRetryAfter } from "../../apps/server/src/drive/errors.ts";
import { withDriveRetry } from "../../apps/server/src/drive/retry.ts";

describe("classifyDriveResponse", () => {
  test("marks 429 retryable and honors retry-after", () => {
    const err = classifyDriveResponse(429, "", "3");
    expect(err.category).toBe("rate_limit");
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(3000);
  });

  test("marks 403 rateLimitExceeded retryable", () => {
    const body = '{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}';
    const err = classifyDriveResponse(403, body, null);
    expect(err.category).toBe("rate_limit");
    expect(err.retryable).toBe(true);
  });

  test("classifies storageQuotaExceeded", () => {
    const body = '{"error":{"errors":[{"reason":"storageQuotaExceeded"}]}}';
    const err = classifyDriveResponse(403, body, null);
    expect(err.category).toBe("quota_exceeded");
    expect(err.retryable).toBe(false);
  });

  test("marks 500 retryable", () => {
    const err = classifyDriveResponse(503, "", null);
    expect(err.retryable).toBe(true);
    expect(err.category).toBe("server_error");
  });

  test("marks 401 as unauthorized token revoked", () => {
    const err = classifyDriveResponse(401, "", null);
    expect(err.tokenRevoked).toBe(true);
  });

  test("marks 400 non-retryable invalid request", () => {
    const err = classifyDriveResponse(400, "", null);
    expect(err.retryable).toBe(false);
    expect(err.category).toBe("invalid_request");
  });
});

describe("parseRetryAfter", () => {
  test("delta seconds", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("0")).toBe(0);
  });
  test("http date", () => {
    const future = new Date(Date.now() + 2000).toUTCString();
    const ms = parseRetryAfter(future) ?? 0;
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThan(4000);
  });
  test("invalid returns null", () => {
    expect(parseRetryAfter("nope")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe("withDriveRetry", () => {
  test("retries retryable errors then succeeds", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await withDriveRetry(
      async () => {
        calls++;
        if (calls < 3) {
          throw new DriveError({
            status: 500,
            category: "server_error",
            message: "boom",
            retryable: true,
          });
        }
        return "ok";
      },
      {
        maxAttempts: 5,
        baseDelayMs: 5,
        random: () => 0,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays.length).toBe(2);
    expect(delays[0]).toBe(5);
    expect(delays[1]).toBe(10);
  });

  test("does not retry non-retryable DriveError", async () => {
    let calls = 0;
    await expect(
      withDriveRetry(
        async () => {
          calls++;
          throw new DriveError({
            status: 400,
            category: "invalid_request",
            message: "bad",
          });
        },
        { maxAttempts: 5, baseDelayMs: 1, sleep: async () => {} },
      ),
    ).rejects.toThrow("bad");
    expect(calls).toBe(1);
  });

  test("gives up after maxAttempts", async () => {
    let calls = 0;
    await expect(
      withDriveRetry(
        async () => {
          calls++;
          throw new DriveError({
            status: 502,
            category: "server_error",
            message: "still bad",
            retryable: true,
          });
        },
        {
          maxAttempts: 3,
          baseDelayMs: 1,
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow("still bad");
    expect(calls).toBe(3);
  });

  test("honors abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      withDriveRetry(async () => "never", {
        maxAttempts: 3,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});
