// Application-level rate limit policies built from AppConfig. The four
// scopes are intentionally independent so exhausting a bad-signature bucket
// cannot lock a user out of OAuth or credential management.

import type { AppConfig } from "../config.ts";
import { KeyedRateLimiter, type LimitDecision } from "./rate-limit.ts";

export type RateLimitScope =
  | "login"
  | "credentialCreate"
  | "signatureFailure"
  | "s3Public"
  | "publicShare"
  | "mfaVerify";

export class RateLimits {
  private readonly limiters: Record<RateLimitScope, KeyedRateLimiter>;

  constructor(private readonly config: AppConfig) {
    const maxKeys = config.rateLimit.maxKeys;
    this.limiters = {
      login: new KeyedRateLimiter({
        capacity: config.rateLimit.loginPerMinute,
        refillPerSecond: config.rateLimit.loginPerMinute / 60,
        maxKeys,
      }),
      credentialCreate: new KeyedRateLimiter({
        capacity: config.rateLimit.credentialCreatePerHour,
        refillPerSecond: config.rateLimit.credentialCreatePerHour / 3600,
        maxKeys,
      }),
      signatureFailure: new KeyedRateLimiter({
        capacity: config.rateLimit.signatureFailuresPerMinute,
        refillPerSecond: config.rateLimit.signatureFailuresPerMinute / 60,
        maxKeys,
      }),
      s3Public: new KeyedRateLimiter({
        capacity: config.rateLimit.s3PublicRpsPerIp,
        refillPerSecond: config.rateLimit.s3PublicRpsPerIp,
        maxKeys,
      }),
      publicShare: new KeyedRateLimiter({
        capacity: config.rateLimit.publicShareRpsPerIp,
        refillPerSecond: config.rateLimit.publicShareRpsPerIp,
        maxKeys,
      }),
      mfaVerify: new KeyedRateLimiter({
        capacity: config.rateLimit.mfaVerifyPerMinute,
        refillPerSecond: config.rateLimit.mfaVerifyPerMinute / 60,
        maxKeys,
      }),
    };
  }

  take(scope: RateLimitScope, key: string, now?: number): LimitDecision {
    if (!this.config.rateLimit.enabled) {
      return { allowed: true, retryAfterMs: 0, remaining: Number.MAX_SAFE_INTEGER };
    }
    return this.limiters[scope].take(key || "unknown", now);
  }

  reset(scope?: RateLimitScope): void {
    if (scope) {
      this.limiters[scope].reset();
      return;
    }
    for (const limiter of Object.values(this.limiters)) limiter.reset();
  }
}

export function retryAfterSeconds(decision: LimitDecision): string {
  return String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
}
