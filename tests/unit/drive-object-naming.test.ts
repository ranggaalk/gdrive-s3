// The Drive `name` field is cosmetic for identification (appProperties is the
// real key), but it's what a user sees when opening an object directly in
// Google Drive. It must be the real S3 key, not an internal id — see
// storage.ts uploadObject/beginResumableUpload.
import { afterEach, describe, expect, test } from "bun:test";
import { GoogleDriveStorage } from "../../apps/server/src/drive/storage.ts";
import type { TokenProvider } from "../../apps/server/src/drive/oauth-token.ts";
import type { DriveRootsRepository } from "../../apps/server/src/db/repositories/drive-roots.ts";
import type { RuntimeSettingsService } from "../../apps/server/src/services/runtime-settings-service.ts";

const fakeTokens = {
  getAccessToken: async () => "fake-token",
  invalidate: () => {},
} as unknown as TokenProvider;

function newStorage(): GoogleDriveStorage {
  return new GoogleDriveStorage(
    fakeTokens,
    null as unknown as DriveRootsRepository,
    null as unknown as RuntimeSettingsService,
  );
}

describe("GoogleDriveStorage object naming", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("uploadObject names the Drive file after the S3 key, not the internal object id", async () => {
    const captured: { name: string | null } = { name: null };
    globalThis.fetch = (async (_url, init) => {
      const bodyText = await new Response(init!.body as BodyInit).text();
      captured.name = /"name":"([^"]*)"/.exec(bodyText)?.[1] ?? null;
      return Response.json({ id: "file1", size: "3", md5Checksum: "abc" });
    }) as typeof fetch;

    const result = await newStorage().uploadObject({
      userId: "u1",
      bucketFolderId: "folder1",
      objectId: "internal-object-id",
      objectKey: "photos/2024/vacation.jpg",
      bucketId: "bucket1",
      mimeType: "image/jpeg",
      body: new Uint8Array([1, 2, 3]),
    });

    expect(captured.name).toBe("photos/2024/vacation.jpg");
    expect(result.driveFileId).toBe("file1");
  });

  test("beginResumableUpload names the Drive file after the S3 key", async () => {
    let sentBody: { name?: string } = {};
    globalThis.fetch = (async (_url, init) => {
      sentBody = JSON.parse(init!.body as string);
      return new Response(null, { status: 200, headers: { Location: "https://upload.example/session" } });
    }) as typeof fetch;

    await newStorage().beginResumableUpload({
      userId: "u1",
      bucketFolderId: "folder1",
      objectId: "internal-object-id",
      objectKey: "reports/q1.pdf",
      bucketId: "bucket1",
      mimeType: "application/pdf",
    });

    expect(sentBody.name).toBe("reports/q1.pdf");
  });
});
