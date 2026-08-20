// Latency sample accumulator for the Bun-native load harness. Samples are
// capped to avoid memory growth on long runs; when full, reservoir sampling
// keeps a representative distribution while total count continues to grow.

export interface PercentileSummary {
  count: number;
  sampled: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export class LatencySamples {
  private samples: number[] = [];
  private totalCount = 0;
  private totalMs = 0;
  private maxMs = 0;

  constructor(private readonly capacity = 100_000) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("sample capacity must be a positive integer");
    }
  }

  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.totalCount++;
    this.totalMs += ms;
    this.maxMs = Math.max(this.maxMs, ms);
    if (this.samples.length < this.capacity) {
      this.samples.push(ms);
      return;
    }
    // Deterministic reservoir slot: avoids Math.random() and keeps tests
    // reproducible while replacing values evenly over long runs.
    const slot = (this.totalCount * 2654435761) % this.totalCount;
    if (slot < this.capacity) this.samples[slot] = ms;
  }

  summary(): PercentileSummary {
    if (this.totalCount === 0) {
      return { count: 0, sampled: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    return {
      count: this.totalCount,
      sampled: sorted.length,
      mean: round(this.totalMs / this.totalCount),
      p50: round(percentile(sorted, 0.5)),
      p95: round(percentile(sorted, 0.95)),
      p99: round(percentile(sorted, 0.99)),
      max: round(this.maxMs),
    };
  }
}

export function percentile(sorted: number[], rank: number): number {
  if (sorted.length === 0) return 0;
  if (rank <= 0) return sorted[0]!;
  if (rank >= 1) return sorted[sorted.length - 1]!;
  const index = (sorted.length - 1) * rank;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  const weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
