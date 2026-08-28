import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Guards against the UI hiding a feature the server would happily allow.
 *
 * This class of bug shipped twice: the bucket settings dialog was gated to
 * Shared Drive buckets long after it stopped being only about members, and the
 * version-history and copy actions were gated to writable roles even though the
 * server resolves both with read access. Nothing type-checks the relationship
 * between a JSX gate and the permission the route actually requires, so it is
 * asserted here.
 */
function readPage(name: string): string {
  return readFileSync(
    new URL(`../../apps/web/src/pages/${name}`, import.meta.url).pathname,
    "utf8",
  );
}

/** The role gate wrapping the button whose onClick calls `handler`. */
function gateFor(source: string, handler: string): string | null {
  const pattern = new RegExp(
    `\\{(owner|writable)\\s*\\?\\s*<Button[^>]*?onClick=\\{\\(\\) => (?:void )?${handler}\\b`,
  );
  return pattern.exec(source)?.[1] ?? null;
}

/** Whether a button calling `handler` exists at all, gated or not. */
function hasButton(source: string, handler: string): boolean {
  return new RegExp(`onClick=\\{\\(\\) => (?:void )?${handler}\\b`).test(source);
}

describe("Objects page permission gates match the server", () => {
  const source = readPage("ObjectsPage.tsx");

  test("owner-only actions are gated to owners", () => {
    // Drive import, backup, and link management are all owner-only routes.
    for (const handler of ["openImport", "openBackup", "openLinks"]) {
      expect(gateFor(source, handler), handler).toBe("owner");
    }
  });

  test("write actions are gated to writable roles", () => {
    for (const handler of ["openUploadForm", "setShowUpload", "setDeleteTarget"]) {
      expect(gateFor(source, handler), handler).toBe("writable");
    }
  });

  test("read-only actions are not gated behind write access", () => {
    // Listing versions resolves the bucket with "read", and copying reads this
    // object while writing to a different bucket the target picker filters. A
    // viewer can legitimately do both.
    for (const handler of ["openVersions", "openCopy"]) {
      expect(hasButton(source, handler), `${handler} button missing`).toBe(true);
      expect(gateFor(source, handler), `${handler} should not be role-gated`).toBeNull();
    }
  });

  test("deleting a version inside the drawer stays gated to writable roles", () => {
    // The drawer is reachable by viewers now, so the destructive action inside
    // it carries its own gate — the server refuses a viewer's version delete.
    expect(source).toContain("version.isLatest || !writable");
  });

  test("removing a delete marker is labelled as a restore", () => {
    // Deleting a delete marker un-hides the object, so calling it "delete"
    // would tell the user the opposite of what happens.
    expect(source).toContain("version.isDeleteMarker ? t.objects.versionRestore");
  });
});

describe("Buckets page settings are reachable", () => {
  const source = readPage("BucketsPage.tsx");

  test("the settings dialog opens for any owned bucket", () => {
    // It was once gated to Shared Drive buckets, back when it only managed
    // members. It now also holds ACL, policy, versioning, encryption, and
    // Object Lock, which every bucket has.
    expect(source).toMatch(
      /\{bucket\.ownedByMe \? <Button[^>]*?onClick=\{\(\) => void openAccess\(bucket\)\}/,
    );
  });

  test("the settings dialog is not gated on storage kind", () => {
    expect(source).not.toContain('bucket.ownedByMe && bucket.storageKind === "shared_drive"');
  });

  test("only the members tab is Shared Drive specific", () => {
    expect(source).toContain('accessBucket?.storageKind === "shared_drive"');
  });
});
