import { describe, expect, test } from "bun:test";
import { makeHarness } from "../integration/_helpers.ts";
import { tokenHash } from "../../apps/server/src/services/public-link-service.ts";
import {
  contentDisposition,
  isPreviewableContentType,
} from "../../apps/server/src/routes/object-http.ts";
import { maskedRoute } from "../../apps/server/src/routes/public-share.ts";

describe("public object links", () => {
  test("stores only the token hash and revokes independently", async () => {
    const { ctx, seedUser, storage } = makeHarness();
    const user = seedUser("links@x.com");
    const bucket = ctx.repos.buckets.create(user.id, "links-bucket", "us-east-1", "folder");
    const uploaded = await storage.uploadObject({
      userId: user.id,
      bucketFolderId: bucket.drive_folder_id,
      bucketId: bucket.id,
      objectId: "obj-link",
      objectKey: "a.txt",
      mimeType: "text/plain",
      body: new TextEncoder().encode("hello"),
    });
    ctx.repos.objects.upsert({
      bucketId: bucket.id,
      objectKey: "a.txt",
      driveFileId: uploaded.driveFileId,
      sizeBytes: 5,
      contentType: "text/plain",
      etag: uploaded.md5Hex!,
    });

    const object = ctx.repos.objects.findByKey(bucket.id, "a.txt")!;
    const created = ctx.publicLinkService.create({
      ownerUserId: user.id,
      objectId: object.id,
      label: "test",
      expiresAt: null,
    });
    const token = new URL(created.url).pathname.split("/").pop()!;
    const row = ctx.repos.publicObjectLinks.listForObject(user.id, object.id)[0]!;
    expect(row.token_hash).toBe(tokenHash(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(ctx.publicLinkService.resolve(token)?.object_id).toBe(object.id);
    expect(ctx.publicLinkService.revoke(user.id, object.id, created.id)).toBe(true);
    expect(ctx.publicLinkService.resolve(token)).toBeNull();
    ctx.db.close();
  });

  test("uses safe preview types, filenames, and masked routes", () => {
    expect(isPreviewableContentType("image/png")).toBe(true);
    expect(isPreviewableContentType("text/html")).toBe(false);
    expect(isPreviewableContentType("image/svg+xml")).toBe(false);
    expect(contentDisposition("attachment", "folder/résumé.txt")).toContain("filename*=");
    expect(maskedRoute("/__drives3_share/secret-token")).toBe("/__drives3_share/:token");
  });
});
