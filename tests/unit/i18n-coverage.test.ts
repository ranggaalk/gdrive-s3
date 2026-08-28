import { describe, expect, test } from "bun:test";
import { COMPAT_MATRIX } from "../../apps/server/src/compat/matrix.ts";
import { id } from "../../apps/web/src/lib/i18n/id.ts";
import { en } from "../../apps/web/src/lib/i18n/en.ts";

/**
 * The dictionaries are type-checked against each other, but two things cross
 * the server/client boundary and TypeScript cannot see the link: the API error
 * codes and the compatibility-matrix feature labels. Both are plain strings,
 * so they drift silently — a renamed feature or a new error code just falls
 * back to the server's own language, which is how the English UI ended up
 * reporting "Operasi objek gagal".
 */
describe("compatibility matrix note translations", () => {
  test("every server note has an Indonesian override", () => {
    const untranslated = COMPAT_MATRIX.filter(
      (row) => row.notes && !id.compatNotes[row.feature],
    ).map((row) => row.feature);
    expect(untranslated).toEqual([]);
  });

  test("no override points at a feature that no longer exists", () => {
    const features = new Set(COMPAT_MATRIX.map((row) => row.feature));
    const stale = Object.keys(id.compatNotes).filter((key) => !features.has(key));
    expect(stale).toEqual([]);
  });

  test("English falls back to the server notes rather than duplicating them", () => {
    // The server already speaks English, so a second copy here would only be
    // something else to keep in sync.
    expect(Object.keys(en.compatNotes)).toEqual([]);
  });

  test("server notes are the canonical English text", () => {
    // Guards against an Indonesian note being written into the server matrix
    // again, which is what made the English dashboard show Indonesian.
    const indonesianMarkers = /\b(yang|dengan|tidak|bisa|belum|hanya|dilayani|lewat|serta)\b/;
    const suspect = COMPAT_MATRIX.filter(
      (row) => row.notes && indonesianMarkers.test(row.notes),
    ).map((row) => row.feature);
    expect(suspect).toEqual([]);
  });
});

describe("API error message translations", () => {
  test("both locales cover exactly the same codes", () => {
    expect(Object.keys(id.apiErrors).sort()).toEqual(Object.keys(en.apiErrors).sort());
  });

  test("no message is left empty", () => {
    for (const [code, message] of Object.entries(id.apiErrors)) {
      expect(message.length, `id.apiErrors.${code}`).toBeGreaterThan(0);
    }
    for (const [code, message] of Object.entries(en.apiErrors)) {
      expect(message.length, `en.apiErrors.${code}`).toBeGreaterThan(0);
    }
  });

  test("the codes the routes actually emit are all translated", async () => {
    // Read the route sources rather than trusting a hand-maintained list, so a
    // newly introduced code fails here instead of reaching a user untranslated.
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL("../../apps/server/src/routes/", import.meta.url).pathname;
    const emitted = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(`${dir}${file}`, "utf8");
      for (const match of source.matchAll(/apiError\(\s*"([A-Z_]+)"/g)) {
        emitted.add(match[1]!);
      }
    }
    expect(emitted.size).toBeGreaterThan(10);

    const missing = [...emitted].filter((code) => !(code in id.apiErrors)).sort();
    expect(missing).toEqual([]);
  });
});
