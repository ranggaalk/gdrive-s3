import { afterEach, describe, expect, test } from "bun:test";
import type { AppContext } from "../../apps/server/src/context.ts";
import { handleApi } from "../../apps/server/src/routes/api.ts";
import { handleS3 } from "../../apps/server/src/s3/router.ts";
import { makeHarness } from "./_helpers.ts";

function unwrap<T>(body: unknown): T {
  return (body as { data: T }).data;
}

let ctxToClose: AppContext | null = null;
afterEach(() => {
  ctxToClose?.db.close();
  ctxToClose = null;
});

const ORIGIN = "http://localhost:5173";

async function setup() {
  const harness = makeHarness({ appOrigin: ORIGIN });
  const { ctx, seedUser, seedCredential } = harness;
  ctxToClose = ctx;
  const user = seedUser("owner@x.com");
  const cred = seedCredential(user.id);
  const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
  await harness.signAndSend({ method: "PUT", path: "/media", ...auth });
  await harness.signAndSend({ method: "PUT", path: "/media/logo.png", body: "PNG", ...auth });

  const session = ctx.sessionService.establish({ userId: user.id, userAgent: "test", ip: null });
  const cookie = `drives3_sid=${session.rawId}`;
  const bucketId = ctx.repos.buckets.listByName("media")[0]!.id;

  const api = (path: string, init: RequestInit = {}) =>
    handleApi(ctx, new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: {
        cookie,
        origin: ORIGIN,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.method && init.method !== "GET" ? { "x-csrf-token": session.csrfSecret } : {}),
        ...(init.headers ?? {}),
      },
    }), `req_${crypto.randomUUID()}`);

  const anonymousGet = () =>
    handleS3(ctx, new Request("http://localhost/media/logo.png", {
      headers: { host: "localhost" },
    }), "req_anon");

  return { harness, ctx, user, auth, bucketId, api, anonymousGet };
}

describe("control-plane bucket access configuration", () => {
  test("reports the default private configuration", async () => {
    const { api, bucketId } = await setup();
    const res = await api(`/api/buckets/${bucketId}/access`);
    expect(res.status).toBe(200);
    // Asserts the access-control defaults specifically, rather than the exact
    // object shape, so later stages can add fields without breaking this.
    expect(unwrap<Record<string, unknown>>(await res.json())).toMatchObject({
      acl: "private",
      policy: null,
      policyUpdatedAt: null,
      isPublic: false,
      defaultSseAlgorithm: null,
      defaultKmsKeyId: null,
    });
  });

  test("setting the ACL to public-read really opens the data plane", async () => {
    const { api, bucketId, anonymousGet } = await setup();
    expect((await anonymousGet()).status).toBe(404);

    const res = await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ acl: "public-read" }),
    });
    expect(res.status).toBe(200);
    const updated = unwrap<{ acl: string; isPublic: boolean }>(await res.json());
    expect(updated.acl).toBe("public-read");
    expect(updated.isPublic).toBe(true);

    const anon = await anonymousGet();
    expect(anon.status).toBe(200);
    expect(await anon.text()).toBe("PNG");
  });

  test("a policy can be stored, reported, and cleared with null", async () => {
    const { api, bucketId, anonymousGet } = await setup();
    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow", Principal: "*", Action: "s3:GetObject",
        Resource: "arn:aws:s3:::media/*",
      }],
    });

    const put = await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ policy }),
    });
    expect(put.status).toBe(200);
    const stored = unwrap<{ policy: string; isPublic: boolean; policyUpdatedAt: string }>(await put.json());
    expect(JSON.parse(stored.policy)).toEqual(JSON.parse(policy));
    expect(stored.isPublic).toBe(true);
    expect(stored.policyUpdatedAt).toBeTruthy();
    expect((await anonymousGet()).status).toBe(200);

    const cleared = await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ policy: null }),
    });
    expect(unwrap<{ policy: string | null }>(await cleared.json()).policy).toBeNull();
    expect((await anonymousGet()).status).toBe(404);
  });

  test("an invalid ACL or policy is rejected and nothing changes", async () => {
    const { api, bucketId } = await setup();

    const badAcl = await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ acl: "not-an-acl" }),
    });
    expect(badAcl.status).toBe(400);

    const badPolicy = await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ policy: '{"Statement":[{"Effect":"Maybe"}]}' }),
    });
    expect(badPolicy.status).toBe(400);

    const after = await api(`/api/buckets/${bucketId}/access`);
    expect(unwrap<Record<string, unknown>>(await after.json())).toMatchObject({
      acl: "private",
      policy: null,
    });
  });

  test("only the owner may read or change the access configuration", async () => {
    const { ctx, bucketId } = await setup();
    const stranger = ctx.repos.users.upsertOnLogin({
      googleSub: "sub-stranger",
      email: "stranger@x.com",
      displayName: null,
      hostedDomain: "x.com",
    });
    const session = ctx.sessionService.establish({
      userId: stranger.id, userAgent: "test", ip: null,
    });
    const headers = { cookie: `drives3_sid=${session.rawId}`, origin: ORIGIN };

    const read = await handleApi(
      ctx,
      new Request(`${ORIGIN}/api/buckets/${bucketId}/access`, { headers }),
      "req_stranger_read",
    );
    expect(read.status).toBe(404);

    const write = await handleApi(
      ctx,
      new Request(`${ORIGIN}/api/buckets/${bucketId}/access`, {
        method: "PUT",
        headers: {
          ...headers,
          "content-type": "application/json",
          "x-csrf-token": session.csrfSecret,
        },
        body: JSON.stringify({ acl: "public-read" }),
      }),
      "req_stranger_write",
    );
    expect(write.status).toBe(404);
  });

  test("the bucket list flags a public bucket", async () => {
    const { api, bucketId } = await setup();
    const before = await api("/api/buckets");
    expect(unwrap<Array<{ isPublic: boolean }>>(await before.json())[0]!.isPublic).toBe(false);

    await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ acl: "public-read" }),
    });

    const after = await api("/api/buckets");
    expect(unwrap<Array<{ isPublic: boolean }>>(await after.json())[0]!.isPublic).toBe(true);
  });
});
