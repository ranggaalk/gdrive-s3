import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { multipartEtag } from "../../apps/server/src/s3/multipart-stream.ts";
import { UploadLockRegistry, withUploadLock } from "../../apps/server/src/util/upload-lock.ts";
import type { MultipartPartRow } from "../../apps/server/src/db/repositories/multipart-parts.ts";

function part(number: number, body: string): MultipartPartRow {
  return {
    upload_id: "mpu_" + "a".repeat(32),
    part_number: number,
    temp_path: `/tmp/${number}.part`,
    size_bytes: body.length,
    etag: createHash("md5").update(body).digest("hex"),
    checksum_sha256: null,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("multipartEtag", () => {
  test("hashes concatenated binary part MD5 digests", () => {
    const parts = [part(1, "hello"), part(2, "world")];
    const expected =
      createHash("md5")
        .update(Buffer.concat(parts.map((p) => Buffer.from(p.etag, "hex"))))
        .digest("hex") + "-2";
    expect(multipartEtag(parts)).toBe(expected);
  });
});

describe("UploadLockRegistry", () => {
  test("serializes same-key operations FIFO", async () => {
    const registry = new UploadLockRegistry();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withUploadLock(registry, "upload", async () => {
      events.push("first:start");
      await gate;
      events.push("first:end");
    });
    await new Promise((r) => setTimeout(r, 1));
    const second = withUploadLock(registry, "upload", async () => {
      events.push("second");
    });
    await new Promise((r) => setTimeout(r, 1));
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  test("different keys can execute concurrently", async () => {
    const registry = new UploadLockRegistry();
    let running = 0;
    let peak = 0;
    const work = (key: string) =>
      withUploadLock(registry, key, async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
      });
    await Promise.all([work("a"), work("b")]);
    expect(peak).toBe(2);
  });
});
