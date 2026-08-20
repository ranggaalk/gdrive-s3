import { describe, expect, test } from "bun:test";
import { parseRange } from "../../apps/server/src/s3/range.ts";
import { evaluateConditions } from "../../apps/server/src/s3/conditions.ts";
import { S3Error } from "../../apps/server/src/s3/errors.ts";

describe("parseRange", () => {
  const size = 100;
  test("null when no header", () => {
    expect(parseRange(null, size)).toBeNull();
  });
  test("closed range", () => {
    const r = parseRange("bytes=10-19", size)!;
    expect(r.start).toBe(10);
    expect(r.end).toBe(19);
    expect(r.length).toBe(10);
    expect(r.headerValue).toBe("bytes=10-19");
  });
  test("open ended range clamps to size", () => {
    const r = parseRange("bytes=90-", size)!;
    expect(r.start).toBe(90);
    expect(r.end).toBe(99);
    expect(r.length).toBe(10);
  });
  test("suffix range", () => {
    const r = parseRange("bytes=-30", size)!;
    expect(r.start).toBe(70);
    expect(r.end).toBe(99);
    expect(r.length).toBe(30);
  });
  test("multi-range rejected", () => {
    expect(() => parseRange("bytes=0-1, 2-3", size)).toThrow(S3Error);
  });
  test("unsatisfiable range raises InvalidRange", () => {
    try {
      parseRange("bytes=100-200", size);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(S3Error);
      const s = err as S3Error;
      expect(s.code).toBe("InvalidRange");
      expect(s.details.ContentRange).toBe("bytes */100");
    }
  });
});

const obj = {
  etag: "abc",
  last_modified_at: "2026-06-01T00:00:00.000Z",
};

describe("evaluateConditions", () => {
  test("If-Match hit proceeds", () => {
    const h = new Headers({ "If-Match": '"abc"' });
    expect(evaluateConditions(h, obj)).toBe("proceed");
  });
  test("If-Match miss fails precondition", () => {
    const h = new Headers({ "If-Match": '"other"' });
    expect(() => evaluateConditions(h, obj)).toThrow(S3Error);
  });
  test("If-None-Match hit returns 304 semantics", () => {
    const h = new Headers({ "If-None-Match": '"abc"' });
    expect(evaluateConditions(h, obj)).toBe("not-modified");
  });
  test("If-Modified-Since older triggers 304", () => {
    const h = new Headers({ "If-Modified-Since": new Date(Date.parse(obj.last_modified_at) + 1000).toUTCString() });
    expect(evaluateConditions(h, obj)).toBe("not-modified");
  });
  test("If-Unmodified-Since older fails", () => {
    const h = new Headers({ "If-Unmodified-Since": new Date(Date.parse(obj.last_modified_at) - 1000).toUTCString() });
    expect(() => evaluateConditions(h, obj)).toThrow(S3Error);
  });
});
