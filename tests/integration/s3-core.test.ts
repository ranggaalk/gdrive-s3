import { describe, expect, test } from "bun:test";
import { makeHarness } from "./_helpers.ts";

async function text(res: Response): Promise<string> {
  return res.text();
}

describe("S3 core integration", () => {
  test("create → put → head → get → list → delete → delete bucket", async () => {
    const h = makeHarness();
    const user = h.seedUser("a@x.com");
    const cred = h.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };

    // ListBuckets initially empty.
    let res = await h.signAndSend({ method: "GET", path: "/", ...auth });
    expect(res.status).toBe(200);
    expect(await text(res)).toContain("<Buckets></Buckets>");

    // Create + head bucket.
    res = await h.signAndSend({ method: "PUT", path: "/docs", ...auth });
    expect(res.status).toBe(200);
    res = await h.signAndSend({ method: "HEAD", path: "/docs", ...auth });
    expect(res.status).toBe(200);

    // Put object with metadata and an intentionally path-like key.
    const body = "hello s3\n";
    res = await h.signAndSend({
      method: "PUT",
      path: "/docs/a//hello.txt",
      headers: {
        "content-type": "text/plain",
        "x-amz-meta-owner": "alice",
      },
      body,
      ...auth,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);

    // Head returns metadata, size, etag.
    res = await h.signAndSend({ method: "HEAD", path: "/docs/a//./hello.txt", ...auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(body.length));
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("x-amz-meta-owner")).toBe("alice");

    // Get streams exact bytes.
    res = await h.signAndSend({ method: "GET", path: "/docs/a//./hello.txt", ...auth });
    expect(res.status).toBe(200);
    expect(await text(res)).toBe(body);

    // ListObjectsV2 sees the un-normalized key.
    res = await h.signAndSend({
      method: "GET",
      path: "/docs",
      query: { "list-type": "2", prefix: "a/" },
      ...auth,
    });
    const listXml = await text(res);
    expect(res.status).toBe(200);
    expect(listXml).toContain("<Key>a//hello.txt</Key>");
    // The repeated slash survives transport and is preserved in the stored
    // key. The application performs no path normalization.
    expect(listXml).toContain("<KeyCount>1</KeyCount>");

    // Bucket cannot be deleted while non-empty.
    res = await h.signAndSend({ method: "DELETE", path: "/docs", ...auth });
    expect(res.status).toBe(409);
    expect(await text(res)).toContain("<Code>BucketNotEmpty</Code>");

    // Delete object is idempotent.
    res = await h.signAndSend({ method: "DELETE", path: "/docs/a//./hello.txt", ...auth });
    expect(res.status).toBe(204);
    res = await h.signAndSend({ method: "DELETE", path: "/docs/a//./hello.txt", ...auth });
    expect(res.status).toBe(204);

    // Delete empty bucket.
    res = await h.signAndSend({ method: "DELETE", path: "/docs", ...auth });
    expect(res.status).toBe(204);
  });

  test("ownership isolation: user B cannot see user A bucket/object", async () => {
    const h = makeHarness();
    const a = h.seedUser("a@x.com");
    const b = h.seedUser("b@x.com");
    const ca = h.seedCredential(a.id);
    const cb = h.seedCredential(b.id);

    await h.signAndSend({
      method: "PUT",
      path: "/private",
      accessKeyId: ca.accessKeyId,
      secretAccessKey: ca.secretAccessKey,
    });
    await h.signAndSend({
      method: "PUT",
      path: "/private/secret.txt",
      body: "secret",
      accessKeyId: ca.accessKeyId,
      secretAccessKey: ca.secretAccessKey,
    });

    const listB = await h.signAndSend({
      method: "GET",
      path: "/",
      accessKeyId: cb.accessKeyId,
      secretAccessKey: cb.secretAccessKey,
    });
    expect(await text(listB)).not.toContain("private");

    const getB = await h.signAndSend({
      method: "GET",
      path: "/private/secret.txt",
      accessKeyId: cb.accessKeyId,
      secretAccessKey: cb.secretAccessKey,
    });
    // Conceal ownership boundary as NoSuchBucket, not AccessDenied leakage.
    expect(getB.status).toBe(404);
    expect(await text(getB)).toContain("<Code>NoSuchBucket</Code>");
  });

  test("invalid signature and unknown access key get S3 XML errors", async () => {
    const h = makeHarness();
    const user = h.seedUser("a@x.com");
    const c = h.seedCredential(user.id);

    let res = await h.signAndSend({
      method: "GET",
      path: "/",
      accessKeyId: c.accessKeyId,
      secretAccessKey: "wrong-secret-key-that-is-still-long-enough",
    });
    expect(res.status).toBe(403);
    expect(await text(res)).toContain("<Code>SignatureDoesNotMatch</Code>");

    res = await h.signAndSend({
      method: "GET",
      path: "/",
      accessKeyId: "AKIAUNKNOWN0000000000",
      secretAccessKey: c.secretAccessKey,
    });
    expect(res.status).toBe(403);
    expect(await text(res)).toContain("<Code>InvalidAccessKeyId</Code>");
  });
});
