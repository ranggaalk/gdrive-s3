import { describe, expect, test } from "bun:test";
import { makeHarness } from "./_helpers.ts";

describe("S3 virtual-hosted-style addressing", () => {
  test("create → put → get → list a bucket addressed via subdomain", async () => {
    const h = makeHarness({ s3VirtualHostedDomain: "storage.example.com" });
    const user = h.seedUser("a@x.com");
    const cred = h.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
    const vhost = { host: "docs.storage.example.com" };

    // CreateBucket: Host carries the bucket name, path is bucket-root.
    let res = await h.signAndSend({ method: "PUT", path: "/", headers: vhost, ...auth });
    expect(res.status).toBe(200);

    // PutObject: path is the key only, no bucket segment.
    const body = "hello vhost\n";
    res = await h.signAndSend({
      method: "PUT",
      path: "/hello.txt",
      headers: { ...vhost, "content-type": "text/plain" },
      body,
      ...auth,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);

    // GetObject via the same subdomain.
    res = await h.signAndSend({ method: "GET", path: "/hello.txt", headers: vhost, ...auth });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);

    // ListObjectsV2 on the bucket root.
    res = await h.signAndSend({
      method: "GET",
      path: "/",
      query: { "list-type": "2" },
      headers: vhost,
      ...auth,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Key>hello.txt</Key>");
  });

  test("the bare configured domain (no subdomain) still resolves as path-style ListBuckets", async () => {
    const h = makeHarness({ s3VirtualHostedDomain: "storage.example.com" });
    const user = h.seedUser("a@x.com");
    const cred = h.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };

    const res = await h.signAndSend({
      method: "GET",
      path: "/",
      headers: { host: "storage.example.com" },
      ...auth,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Buckets>");
  });

  test("path-style keeps working unchanged when the request Host doesn't match the configured domain", async () => {
    const h = makeHarness({ s3VirtualHostedDomain: "storage.example.com" });
    const user = h.seedUser("a@x.com");
    const cred = h.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };

    const res = await h.signAndSend({ method: "PUT", path: "/docs", ...auth });
    expect(res.status).toBe(200);
  });
});
