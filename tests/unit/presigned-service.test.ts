import { describe, expect, test } from "bun:test";
import { makeHarness } from "../integration/_helpers.ts";
import { SigV4PresignedVerifier } from "../../apps/server/src/auth/s3-sigv4-presigned.ts";

describe("PresignedUrlService", () => {
  test("generates a verifier-compatible URL for unusual object keys", () => {
    const { ctx, seedUser } = makeHarness();
    const user = seedUser("presign@x.com");
    const created = ctx.credentialService.create(user.id, "presign");
    const bucket = ctx.repos.buckets.create(user.id, "presign-bucket", "us-east-1", "folder");
    const object = ctx.repos.objects.upsert({
      bucketId: bucket.id,
      objectKey: "folder/a b%25.txt",
      driveFileId: "file",
      sizeBytes: 1,
      contentType: "text/plain",
      etag: "etag",
    }).current;
    const signed = ctx.presignedUrlService.createGet({
      userId: user.id,
      credentialId: created.id,
      bucketName: bucket.name,
      object,
      expiresSeconds: 3600,
    });
    const url = new URL(signed.url);
    expect(url.pathname).toContain("a%20b%2525.txt");
    let result = new SigV4PresignedVerifier(ctx.config, ctx.repos.credentials).verify({
      method: "GET",
      pathname: url.pathname,
      query: url.searchParams,
      headers: new Headers({ host: url.host }),
    });
    expect(result?.ok).toBe(true);
    ctx.credentialService.revoke(user.id, created.id);
    result = new SigV4PresignedVerifier(ctx.config, ctx.repos.credentials).verify({
      method: "GET",
      pathname: url.pathname,
      query: url.searchParams,
      headers: new Headers({ host: url.host }),
    });
    expect(result).toMatchObject({ ok: false, failure: "InvalidAccessKeyId" });
    ctx.db.close();
  });
});
