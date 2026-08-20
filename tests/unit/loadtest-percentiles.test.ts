import { describe, expect, test } from "bun:test";
import { LatencySamples, percentile } from "../../scripts/loadtest/percentiles.ts";

describe("percentile", () => {
  test("interpolates known values", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([0, 100], 0.95)).toBe(95);
    expect(percentile([1], 0.99)).toBe(1);
  });

  test("handles empty and boundary ranks", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 1)).toBe(3);
  });
});

describe("LatencySamples", () => {
  test("summarizes count, mean, percentiles and max", () => {
    const samples = new LatencySamples();
    for (const value of [1, 2, 3, 4, 100]) samples.record(value);
    expect(samples.summary()).toEqual({
      count: 5,
      sampled: 5,
      mean: 22,
      p50: 3,
      p95: 80.8,
      p99: 96.16,
      max: 100,
    });
  });

  test("bounds retained sample memory", () => {
    const samples = new LatencySamples(10);
    for (let i = 0; i < 1000; i++) samples.record(i);
    const result = samples.summary();
    expect(result.count).toBe(1000);
    expect(result.sampled).toBe(10);
    expect(result.max).toBe(999);
  });

  test("ignores invalid samples", () => {
    const samples = new LatencySamples();
    samples.record(-1);
    samples.record(Number.NaN);
    expect(samples.summary().count).toBe(0);
  });
});
