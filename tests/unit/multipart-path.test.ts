import { describe, expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertUnder,
  assertUploadId,
  assertPartNumber,
  ensureSafeUploadDir,
  multipartPartPath,
} from "../../apps/server/src/util/multipart-path.ts";

const validUploadId = "mpu_" + "a".repeat(32);

describe("assertUploadId", () => {
  test("accepts a well-formed upload id", () => {
    expect(() => assertUploadId(validUploadId)).not.toThrow();
  });
  test("rejects path traversal fragments", () => {
    expect(() => assertUploadId("../evil")).toThrow();
    expect(() => assertUploadId("mpu_" + "a".repeat(30))).toThrow();
  });
});

describe("assertPartNumber", () => {
  test("rejects out-of-range or non-integer values", () => {
    expect(() => assertPartNumber(0)).toThrow();
    expect(() => assertPartNumber(-1)).toThrow();
    expect(() => assertPartNumber(1.5)).toThrow();
    expect(() => assertPartNumber(20_000)).toThrow();
    expect(() => assertPartNumber(1)).not.toThrow();
    expect(() => assertPartNumber(10_000)).not.toThrow();
  });
});

describe("assertUnder", () => {
  test("rejects absolute or escaping paths", () => {
    const base = mkdtempSync(join(tmpdir(), "mp-base-"));
    try {
      expect(() => assertUnder(base, "/etc/passwd")).toThrow();
      expect(() => assertUnder(base, join(base, "..", "elsewhere"))).toThrow();
      expect(() => assertUnder(base, base)).toThrow();
      const good = join(base, "inside", "1.part");
      expect(assertUnder(base, good)).toBe(good);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("multipartPartPath", () => {
  test("anchors part paths under the base dir", () => {
    const base = mkdtempSync(join(tmpdir(), "mp-parts-"));
    try {
      const p = multipartPartPath(base, validUploadId, 5);
      expect(p.startsWith(base)).toBe(true);
      expect(p.endsWith("5.part")).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("ensureSafeUploadDir", () => {
  test("refuses a symlinked base directory", async () => {
    const real = mkdtempSync(join(tmpdir(), "mp-real-"));
    const linkParent = mkdtempSync(join(tmpdir(), "mp-link-"));
    const link = join(linkParent, "base");
    symlinkSync(real, link, "dir");
    try {
      await expect(ensureSafeUploadDir(link, validUploadId)).rejects.toThrow(
        /base directory is not a real directory/,
      );
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });
});
