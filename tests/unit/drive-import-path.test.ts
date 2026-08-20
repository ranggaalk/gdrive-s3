import { describe, expect, test } from "bun:test";
import {
  encodeImportSegment,
  importFolderPath,
  importObjectKey,
  unsupportedImportReason,
} from "../../apps/server/src/drive/import-path.ts";


describe("Drive import path mapping", () => {
  test("preserves hierarchy and escapes ambiguous segment characters", () => {
    expect(encodeImportSegment("100%/final.pdf")).toBe("100%25%2Ffinal.pdf");
    expect(importFolderPath("laporan", "2026")).toBe("laporan/2026");
    expect(importObjectKey("laporan/2026", "résumé %.pdf")).toBe(
      "laporan/2026/résumé %25.pdf",
    );
  });

  test("rejects keys over the S3 limit", () => {
    expect(() => importObjectKey("", "x".repeat(1025))).toThrow();
  });

  test("classifies unsupported source types", () => {
    expect(unsupportedImportReason({
      mimeType: "application/vnd.google-apps.document",
      canDownload: true,
      trashed: false,
      appProperties: {},
    })).toBe("google_native_not_supported");
    expect(unsupportedImportReason({
      mimeType: "application/pdf",
      canDownload: true,
      trashed: false,
      appProperties: { drives3Type: "object" },
    })).toBe("managed_drives3_item");
  });
});
