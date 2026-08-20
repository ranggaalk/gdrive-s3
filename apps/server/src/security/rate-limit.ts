// Token-bucket rate limiter (AGENTS.md §20). Two flavours:
//
// - `TokenBucket`: a single lazy bucket. Refills on demand from `performance.now()`
//   so we do not schedule timers.
// - `KeyedRateLimiter`: a bounded map of buckets. Bounded by `maxKeys` so an
//   attacker cannot force unbounded memory growth by spraying keys.
//
// Both are synchronous; callers turn a `LimitDecision` into whatever their
// protocol needs (HTTP 429, S3 SlowDown, etc.).

export interface LimitDecision {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    readonly capacity: number,
    readonly refillPerSecond: number,
    now: number = performance.now(),
  ) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error("capacity must be > 0");
    }
    if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
      throw new Error("refillPerSecond must be > 0");
    }
    this.tokens = capacity;
    this.lastRefill = now;
  }

  take(now: number = performance.now()): LimitDecision {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { allowed: true, retryAfterMs: 0, remaining: Math.floor(this.tokens) };
    }
    const needed = 1 - this.tokens;
    const retryAfterMs = Math.max(1, Math.ceil((needed / this.refillPerSecond) * 1000));
    return { allowed: false, retryAfterMs, remaining: 0 };
  }

  /** Number of full tokens currently available. Test-only helper. */
  peek(now: number = performance.now()): number {
    this.refill(now);
    return this.tokens;
  }

  private refill(now: number): void {
    const elapsedMs = Math.max(0, now - this.lastRefill);
    if (elapsedMs === 0) return;
    const added = (elapsedMs / 1000) * this.refillPerSecond;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefill = now;
  }
}

export interface KeyedLimiterOptions {
  capacity: number;
  refillPerSecond: number;
  maxKeys: number;
}

/**
 * Bounded map of TokenBuckets keyed by an opaque string. When the map hits
 * `maxKeys`, the oldest bucket (Map insertion order = LRU because take() also
 * refreshes recency) is evicted before allocating a new one.
 */
export class KeyedRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  constructor(private readonly opts: KeyedLimiterOptions) {
    if (opts.maxKeys < 1) throw new Error("maxKeys must be >= 1");
  }

  take(key: string, now: number = performance.now()): LimitDecision {
    let bucket = this.buckets.get(key);
    if (bucket) {
      // Refresh recency for LRU eviction.
      this.buckets.delete(key);
    } else {
      if (this.buckets.size >= this.opts.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      bucket = new TokenBucket(this.opts.capacity, this.opts.refillPerSecond, now);
    }
    this.buckets.set(key, bucket);
    return bucket.take(now);
  }

  /** Reset — test-only, never used at runtime. */
  reset(): void {
    this.buckets.clear();
  }

  /** Number of unique keys tracked. */
  size(): number {
    return this.buckets.size;
  }
}
