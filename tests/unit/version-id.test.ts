import { describe, expect, test } from "bun:test";
import { newVersionId } from "../../apps/server/src/db/repositories/object-versions.ts";

// Version ids are ordered by plain string comparison (ORDER BY version_id ASC,
// newest first). Two writes in the same millisecond used to fall back to a
// random tail, which made "the newest version" a coin flip after a rapid
// overwrite.
describe("newVersionId", () => {
  test("sorts newest first, even within one millisecond", () => {
    const ids = Array.from({ length: 2000 }, () => newVersionId());
    expect([...ids].sort()).toEqual([...ids].reverse());
  });

  test("is unique across a burst", () => {
    const ids = Array.from({ length: 2000 }, () => newVersionId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("keeps a fixed width so string order matches time order", () => {
    const ids = Array.from({ length: 50 }, () => newVersionId());
    expect(new Set(ids.map((id) => id.length)).size).toBe(1);
    expect(ids[0]!.startsWith("v")).toBe(true);
  });

  test("orders across milliseconds too", async () => {
    const first = newVersionId();
    await Bun.sleep(2);
    const second = newVersionId();
    expect(second < first).toBe(true);
  });
});
