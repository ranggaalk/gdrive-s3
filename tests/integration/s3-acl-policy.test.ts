import { describe, expect, test } from "bun:test";
import { makeHarness } from "./_helpers.ts";
import { handleS3 } from "../../apps/server/src/s3/router.ts";

/** An unsigned request, exactly as `curl` with no credentials would send it. */
function anonymous(
  h: ReturnType<typeof makeHarness>,
  input: { method: string; path: string; query?: Record<string, string>; body?: string },
): Promise<Response> {
  const url = new URL(`http://localhost${input.path}`);
  for (const [k, v] of Object.entries(input.query ?? {})) url.searchParams.set(k, v);
  return handleS3(
    h.ctx,
    new Request(url.toString(), {
      method: input.method,
      headers: { host: "localhost" },
      body: input.body,
    }),
    `req_${crypto.randomUUID()}`,
  );
}

async function setup() {
  const h = makeHarness();
  const owner = h.seedUser("owner@x.com");
  const cred = h.seedCredential(owner.id);
  const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
  await h.signAndSend({ method: "PUT", path: "/media", ...auth });
  await h.signAndSend({ method: "PUT", path: "/media/logo.png", body: "PNGDATA", ...auth });
  return { h, owner, cred, auth };
}

const PUBLIC_READ_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "PublicRead",
      Effect: "Allow",
      Principal: "*",
      Action: "s3:GetObject",
      Resource: "arn:aws:s3:::media/*",
    },
  ],
});

describe("anonymous access", () => {
  test("a private bucket refuses anonymous reads", async () => {
    const { h } = await setup();
    const res = await anonymous(h, { method: "GET", path: "/media/logo.png" });
    expect(res.status).toBe(404);
    // The bucket's existence is not disclosed to an anonymous stranger.
    expect(await res.text()).toContain("NoSuchBucket");
  });

  test("a public-read bucket ACL admits an anonymous GET", async () => {
    const { h, auth } = await setup();
    const put = await h.signAndSend({
      method: "PUT",
      path: "/media",
      query: { acl: "" },
      headers: { "x-amz-acl": "public-read" },
      ...auth,
    });
    expect(put.status).toBe(200);

    const res = await anonymous(h, { method: "GET", path: "/media/logo.png" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PNGDATA");
  });

  test("a public-read bucket still refuses anonymous writes", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({
      method: "PUT", path: "/media", query: { acl: "" },
      headers: { "x-amz-acl": "public-read" }, ...auth,
    });
    const res = await anonymous(h, { method: "PUT", path: "/media/evil.txt", body: "x" });
    expect(res.status).toBe(404);
    // Nothing was written.
    const check = await h.signAndSend({ method: "GET", path: "/media/evil.txt", ...auth });
    expect(check.status).toBe(404);
  });

  test("public-read-write admits an anonymous write", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({
      method: "PUT", path: "/media", query: { acl: "" },
      headers: { "x-amz-acl": "public-read-write" }, ...auth,
    });
    const res = await anonymous(h, { method: "PUT", path: "/media/drop.txt", body: "anon wrote this" });
    expect(res.status).toBe(200);

    const check = await h.signAndSend({ method: "GET", path: "/media/drop.txt", ...auth });
    expect(await check.text()).toBe("anon wrote this");
  });

  test("a bucket policy admits an anonymous GET without any ACL change", async () => {
    const { h, auth } = await setup();
    const put = await h.signAndSend({
      method: "PUT",
      path: "/media",
      query: { policy: "" },
      body: PUBLIC_READ_POLICY,
      ...auth,
    });
    expect(put.status).toBe(204);

    const res = await anonymous(h, { method: "GET", path: "/media/logo.png" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PNGDATA");
  });

  test("an anonymous caller can never list buckets", async () => {
    const { h } = await setup();
    const res = await anonymous(h, { method: "GET", path: "/" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("AccessDenied");
  });

  test("an anonymous caller can never create or delete a bucket", async () => {
    const { h } = await setup();
    expect((await anonymous(h, { method: "PUT", path: "/newbucket" })).status).toBe(403);
    expect((await anonymous(h, { method: "DELETE", path: "/media" })).status).toBe(403);
  });

  test("anonymous ListBucket follows the bucket ACL", async () => {
    const { h, auth } = await setup();
    const before = await anonymous(h, { method: "GET", path: "/media", query: { "list-type": "2" } });
    expect(before.status).toBe(404);

    await h.signAndSend({
      method: "PUT", path: "/media", query: { acl: "" },
      headers: { "x-amz-acl": "public-read" }, ...auth,
    });
    const after = await anonymous(h, { method: "GET", path: "/media", query: { "list-type": "2" } });
    expect(after.status).toBe(200);
    expect(await after.text()).toContain("<Key>logo.png</Key>");
  });

  test("S3_ALLOW_ANONYMOUS=false makes SigV4 mandatory whatever the ACL says", async () => {
    const h = makeHarness({ s3AllowAnonymous: false });
    const owner = h.seedUser("owner@x.com");
    const cred = h.seedCredential(owner.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
    await h.signAndSend({ method: "PUT", path: "/media", ...auth });
    await h.signAndSend({ method: "PUT", path: "/media/logo.png", body: "PNGDATA", ...auth });
    await h.signAndSend({
      method: "PUT", path: "/media", query: { acl: "" },
      headers: { "x-amz-acl": "public-read" }, ...auth,
    });

    const res = await anonymous(h, { method: "GET", path: "/media/logo.png" });
    expect(res.status).toBe(403);
  });
});

describe("object-level ACL", () => {
  test("a public object is readable inside an otherwise private bucket", async () => {
    const { h, auth } = await setup();
    const put = await h.signAndSend({
      method: "PUT",
      path: "/media/logo.png",
      query: { acl: "" },
      headers: { "x-amz-acl": "public-read" },
      ...auth,
    });
    expect(put.status).toBe(200);

    const open = await anonymous(h, { method: "GET", path: "/media/logo.png" });
    expect(open.status).toBe(200);

    // A sibling object in the same private bucket stays closed.
    await h.signAndSend({ method: "PUT", path: "/media/secret.txt", body: "shh", ...auth });
    const closed = await anonymous(h, { method: "GET", path: "/media/secret.txt" });
    expect(closed.status).toBe(404);
  });

  test("x-amz-acl on PUT sets the object ACL at write time", async () => {
    const { h, auth } = await setup();
    const put = await h.signAndSend({
      method: "PUT",
      path: "/media/open.txt",
      headers: { "x-amz-acl": "public-read" },
      body: "born public",
      ...auth,
    });
    expect(put.status).toBe(200);
    const res = await anonymous(h, { method: "GET", path: "/media/open.txt" });
    expect(await res.text()).toBe("born public");
  });

  test("overwriting an object resets its ACL to the new request's", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({
      method: "PUT", path: "/media/toggle.txt",
      headers: { "x-amz-acl": "public-read" }, body: "v1", ...auth,
    });
    expect((await anonymous(h, { method: "GET", path: "/media/toggle.txt" })).status).toBe(200);

    // No x-amz-acl on the overwrite means private, as in S3.
    await h.signAndSend({ method: "PUT", path: "/media/toggle.txt", body: "v2", ...auth });
    expect((await anonymous(h, { method: "GET", path: "/media/toggle.txt" })).status).toBe(404);
  });

  test("GET ?acl renders the stored ACL and rejects a bad value on PUT", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({
      method: "PUT", path: "/media/logo.png", query: { acl: "" },
      headers: { "x-amz-acl": "public-read" }, ...auth,
    });
    const res = await h.signAndSend({
      method: "GET", path: "/media/logo.png", query: { acl: "" }, ...auth,
    });
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("http://acs.amazonaws.com/groups/global/AllUsers");
    expect(xml).toContain("<Permission>READ</Permission>");

    const bad = await h.signAndSend({
      method: "PUT", path: "/media/logo.png", query: { acl: "" },
      headers: { "x-amz-acl": "not-a-real-acl" }, ...auth,
    });
    expect(bad.status).toBe(400);
  });
});

describe("bucket policy lifecycle", () => {
  test("put, get, status, and delete round-trip", async () => {
    const { h, auth } = await setup();

    expect((await h.signAndSend({ method: "GET", path: "/media", query: { policy: "" }, ...auth })).status).toBe(404);

    const put = await h.signAndSend({
      method: "PUT", path: "/media", query: { policy: "" }, body: PUBLIC_READ_POLICY, ...auth,
    });
    expect(put.status).toBe(204);

    const get = await h.signAndSend({ method: "GET", path: "/media", query: { policy: "" }, ...auth });
    expect(get.status).toBe(200);
    expect(JSON.parse(await get.text())).toEqual(JSON.parse(PUBLIC_READ_POLICY));

    const status = await h.signAndSend({
      method: "GET", path: "/media", query: { policyStatus: "" }, ...auth,
    });
    expect(await status.text()).toContain("<IsPublic>true</IsPublic>");

    const del = await h.signAndSend({
      method: "DELETE", path: "/media", query: { policy: "" }, ...auth,
    });
    expect(del.status).toBe(204);
    expect((await h.signAndSend({ method: "GET", path: "/media", query: { policy: "" }, ...auth })).status).toBe(404);

    // Access closes again once the policy is gone.
    expect((await anonymous(h, { method: "GET", path: "/media/logo.png" })).status).toBe(404);
  });

  test("a malformed policy is rejected rather than stored", async () => {
    const { h, auth } = await setup();
    const bad = await h.signAndSend({
      method: "PUT", path: "/media", query: { policy: "" },
      body: JSON.stringify({ Statement: [{ Effect: "Maybe", Principal: "*", Action: "s3:*", Resource: "*" }] }),
      ...auth,
    });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("MalformedPolicy");
    // Nothing was persisted.
    expect((await h.signAndSend({ method: "GET", path: "/media", query: { policy: "" }, ...auth })).status).toBe(404);
  });

  test("an explicit Deny overrides the owner's own access", async () => {
    const { h, auth } = await setup();
    const denyAll = JSON.stringify({
      Statement: [
        { Effect: "Deny", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::media/locked/*" },
      ],
    });
    await h.signAndSend({ method: "PUT", path: "/media", query: { policy: "" }, body: denyAll, ...auth });
    await h.signAndSend({ method: "PUT", path: "/media/locked/x.txt", body: "hidden", ...auth });

    const denied = await h.signAndSend({ method: "GET", path: "/media/locked/x.txt", ...auth });
    expect(denied.status).toBe(403);
    // A key outside the denied prefix is unaffected.
    expect((await h.signAndSend({ method: "GET", path: "/media/logo.png", ...auth })).status).toBe(200);
  });

  test("a policy can never grant away control of the policy itself", async () => {
    const { h, auth } = await setup();
    const selfGrant = JSON.stringify({
      Statement: [
        { Effect: "Allow", Principal: "*", Action: "s3:*", Resource: ["arn:aws:s3:::media", "arn:aws:s3:::media/*"] },
      ],
    });
    await h.signAndSend({ method: "PUT", path: "/media", query: { policy: "" }, body: selfGrant, ...auth });

    // Even with s3:* granted to everyone, an anonymous caller cannot read or
    // rewrite the policy — those actions are owner-only by construction.
    expect((await anonymous(h, { method: "GET", path: "/media", query: { policy: "" } })).status).toBe(403);
    expect((await anonymous(h, {
      method: "PUT", path: "/media", query: { policy: "" }, body: PUBLIC_READ_POLICY,
    })).status).toBe(403);
    // The data plane grant still works, so the statement was genuinely applied.
    expect((await anonymous(h, { method: "GET", path: "/media/logo.png" })).status).toBe(200);
  });
});

describe("cross-user access", () => {
  test("a policy grants a named user access to another owner's bucket", async () => {
    const { h, auth } = await setup();
    const other = h.seedUser("eric@x.com");
    const otherCred = h.seedCredential(other.id);
    const otherAuth = {
      accessKeyId: otherCred.accessKeyId,
      secretAccessKey: otherCred.secretAccessKey,
    };

    // Without a grant, the bucket is simply not in Eric's namespace.
    expect((await h.signAndSend({ method: "GET", path: "/media/logo.png", ...otherAuth })).status).toBe(404);

    const grant = JSON.stringify({
      Statement: [
        {
          Effect: "Allow",
          Principal: { AWS: "arn:aws:iam:::user/eric@x.com" },
          Action: "s3:GetObject",
          Resource: "arn:aws:s3:::media/*",
        },
      ],
    });
    await h.signAndSend({ method: "PUT", path: "/media", query: { policy: "" }, body: grant, ...auth });

    const granted = await h.signAndSend({ method: "GET", path: "/media/logo.png", ...otherAuth });
    expect(granted.status).toBe(200);
    expect(await granted.text()).toBe("PNGDATA");

    // The grant is read-only: writing is still refused.
    const write = await h.signAndSend({
      method: "PUT", path: "/media/eric.txt", body: "nope", ...otherAuth,
    });
    expect(write.status).toBe(403);
  });

  test("a grant to one user does not admit another", async () => {
    const { h, auth } = await setup();
    const mallory = h.seedUser("mallory@x.com");
    const malloryCred = h.seedCredential(mallory.id);

    const grant = JSON.stringify({
      Statement: [{
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam:::user/eric@x.com" },
        Action: "s3:GetObject",
        Resource: "arn:aws:s3:::media/*",
      }],
    });
    await h.signAndSend({ method: "PUT", path: "/media", query: { policy: "" }, body: grant, ...auth });

    const res = await h.signAndSend({
      method: "GET",
      path: "/media/logo.png",
      accessKeyId: malloryCred.accessKeyId,
      secretAccessKey: malloryCred.secretAccessKey,
    });
    expect(res.status).toBe(404);
  });

  test("an anonymous request cannot resolve a name two owners share", async () => {
    const { h, auth } = await setup();
    // A second owner with a bucket of the same name, also public.
    const other = h.seedUser("eric@x.com");
    const otherCred = h.seedCredential(other.id);
    const otherAuth = {
      accessKeyId: otherCred.accessKeyId,
      secretAccessKey: otherCred.secretAccessKey,
    };
    await h.signAndSend({ method: "PUT", path: "/media", ...otherAuth });
    await h.signAndSend({ method: "PUT", path: "/media/logo.png", body: "OTHER", ...otherAuth });

    for (const a of [auth, otherAuth]) {
      await h.signAndSend({
        method: "PUT", path: "/media", query: { acl: "" },
        headers: { "x-amz-acl": "public-read" }, ...a,
      });
    }

    // Names are unique per user here, so "media" is genuinely ambiguous.
    // Serving either owner's bytes would be a guess, so the request is refused.
    const res = await anonymous(h, { method: "GET", path: "/media/logo.png" });
    expect(res.status).toBe(404);

    // Both owners still reach their own bucket unambiguously.
    expect(await (await h.signAndSend({ method: "GET", path: "/media/logo.png", ...auth })).text()).toBe("PNGDATA");
    expect(await (await h.signAndSend({ method: "GET", path: "/media/logo.png", ...otherAuth })).text()).toBe("OTHER");
  });
});

describe("policy conditions end to end", () => {
  test("an IP condition gates the anonymous grant", async () => {
    const { h, auth } = await setup();
    const ipLocked = JSON.stringify({
      Statement: [{
        Effect: "Allow",
        Principal: "*",
        Action: "s3:GetObject",
        Resource: "arn:aws:s3:::media/*",
        Condition: { IpAddress: { "aws:SourceIp": "10.0.0.0/8" } },
      }],
    });
    await h.signAndSend({ method: "PUT", path: "/media", query: { policy: "" }, body: ipLocked, ...auth });

    // The harness has no client IP, so the condition cannot be satisfied.
    const res = await anonymous(h, { method: "GET", path: "/media/logo.png" });
    expect(res.status).toBe(404);
  });
});
