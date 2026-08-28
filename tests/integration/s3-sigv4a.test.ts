import { describe, expect, test } from "bun:test";
import { makeHarness } from "./_helpers.ts";

describe("SigV4A data plane integration", () => {
  test("full object lifecycle signed with SigV4A", async () => {
    const h = makeHarness();
    const user = h.seedUser("a@x.com");
    const cred = h.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };

    let res = await h.signAndSendV4a({ method: "PUT", path: "/reports", ...auth });
    expect(res.status).toBe(200);

    const body = "signed with ecdsa\n";
    res = await h.signAndSendV4a({
      method: "PUT",
      path: "/reports/q3.txt",
      headers: { "content-type": "text/plain", "x-amz-meta-owner": "alice" },
      body,
      ...auth,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);

    res = await h.signAndSendV4a({ method: "HEAD", path: "/reports/q3.txt", ...auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(body.length));
    expect(res.headers.get("x-amz-meta-owner")).toBe("alice");

    res = await h.signAndSendV4a({ method: "GET", path: "/reports/q3.txt", ...auth });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);

    res = await h.signAndSendV4a({
      method: "GET",
      path: "/reports",
      query: { "list-type": "2" },
      ...auth,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Key>q3.txt</Key>");

    res = await h.signAndSendV4a({ method: "DELETE", path: "/reports/q3.txt", ...auth });
    expect(res.status).toBe(204);
  });

  test("SigV4A and SigV4 sign against the same credential interchangeably", async () => {
    const h = makeHarness();
    const user = h.seedUser("a@x.com");
    const cred = h.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };

    // Bucket created over SigV4A, object written over SigV4, read back over both.
    expect((await h.signAndSendV4a({ method: "PUT", path: "/shared", ...auth })).status).toBe(200);
    expect(
      (await h.signAndSend({ method: "PUT", path: "/shared/k.txt", body: "mixed", ...auth }))
        .status,
    ).toBe(200);

    const viaV4 = await h.signAndSend({ method: "GET", path: "/shared/k.txt", ...auth });
    const viaV4a = await h.signAndSendV4a({ method: "GET", path: "/shared/k.txt", ...auth });
    expect(await viaV4.text()).toBe("mixed");
    expect(await viaV4a.text()).toBe("mixed");
  });

  test("presigned SigV4A query URLs authenticate", async () => {
    const h = makeHarness();
    const user = h.seedUser("a@x.com");
    const cred = h.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };

    await h.signAndSendV4a({ method: "PUT", path: "/presign", ...auth });
    await h.signAndSendV4a({ method: "PUT", path: "/presign/doc.txt", body: "presigned", ...auth });

    const res = await h.signAndSendV4a({
      method: "GET",
      path: "/presign/doc.txt",
      presignExpiresSeconds: 900,
      ...auth,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("presigned");
  });

  test("an expired presigned SigV4A URL is rejected", async () => {
    const h = makeHarness();
    const user = h.seedUser("a@x.com");
    const cred = h.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };

    await h.signAndSendV4a({ method: "PUT", path: "/presign", ...auth });
    await h.signAndSendV4a({ method: "PUT", path: "/presign/doc.txt", body: "presigned", ...auth });

    const res = await h.signAndSendV4a({
      method: "GET",
      path: "/presign/doc.txt",
      presignExpiresSeconds: 60,
      signingDate: new Date(Date.now() - 3600_000),
      ...auth,
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("RequestTimeTooSkewed");
  });

  test("a region set that does not cover this gateway is rejected", async () => {
    const h = makeHarness();
    const user = h.seedUser("a@x.com");
    const cred = h.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };

    await h.signAndSendV4a({ method: "PUT", path: "/regional", ...auth });

    // The gateway serves us-east-1 (see testConfig).
    const ok = await h.signAndSendV4a({
      method: "HEAD",
      path: "/regional",
      regionSet: "us-east-1",
      ...auth,
    });
    expect(ok.status).toBe(200);

    const wrong = await h.signAndSendV4a({
      method: "HEAD",
      path: "/regional",
      regionSet: "eu-west-1",
      ...auth,
    });
    expect(wrong.status).toBe(403);
  });

  test("a SigV4A signature made with the wrong secret is rejected", async () => {
    const h = makeHarness();
    const user = h.seedUser("a@x.com");
    const cred = h.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };

    await h.signAndSendV4a({ method: "PUT", path: "/tamper", ...auth });
    const res = await h.signAndSendV4a({
      method: "HEAD",
      path: "/tamper",
      secretAccessKey: "a-different-secret",
      accessKeyId: cred.accessKeyId,
    });
    expect(res.status).toBe(403);
  });

  test("SigV4A requests outside the clock skew window are rejected", async () => {
    const h = makeHarness();
    const user = h.seedUser("a@x.com");
    const cred = h.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };

    await h.signAndSendV4a({ method: "PUT", path: "/skew", ...auth });
    const res = await h.signAndSendV4a({
      method: "HEAD",
      path: "/skew",
      signingDate: new Date(Date.now() - 30 * 60 * 1000),
      ...auth,
    });
    expect(res.status).toBe(403);
  });

  test("an unknown access key id is rejected", async () => {
    const h = makeHarness();
    h.seedUser("a@x.com");
    const res = await h.signAndSendV4a({
      method: "GET",
      path: "/",
      accessKeyId: "AKIADOESNOTEXIST0000",
      secretAccessKey: "irrelevant",
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("InvalidAccessKeyId");
  });

  test("a malformed SigV4A authorization header does not fall through to SigV4", async () => {
    const h = makeHarness();
    const user = h.seedUser("a@x.com");
    const cred = h.seedCredential(user.id);

    const res = await handleRaw(h, {
      authorization: `AWS4-ECDSA-P256-SHA256 Credential=${cred.accessKeyId}/nonsense, Signature=zz`,
    });
    expect(res.status).toBe(403);
    // AccessDenied is what MalformedAuthorization maps to on the wire.
    expect(await res.text()).toContain("AccessDenied");
  });
});

/** Send a hand-built request straight at the router, bypassing the signer. */
async function handleRaw(
  h: ReturnType<typeof makeHarness>,
  headers: Record<string, string>,
): Promise<Response> {
  const { handleS3 } = await import("../../apps/server/src/s3/router.ts");
  const req = new Request("http://localhost/anything", {
    method: "GET",
    headers: { host: "localhost", ...headers },
  });
  return handleS3(h.ctx, req, "req_raw");
}
