import { afterEach, describe, expect, test } from "bun:test";
import type { AppContext } from "../../apps/server/src/context.ts";
import { handleApi } from "../../apps/server/src/routes/api.ts";
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
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

async function setup() {
  const harness = makeHarness({ appOrigin: ORIGIN });
  const { ctx, seedUser, seedCredential } = harness;
  ctxToClose = ctx;
  const user = seedUser("owner@x.com");
  const cred = seedCredential(user.id);
  const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
  await harness.signAndSend({ method: "PUT", path: "/vault", ...auth });

  const session = ctx.sessionService.establish({ userId: user.id, userAgent: "test", ip: null });
  const bucketId = ctx.repos.buckets.listByName("vault")[0]!.id;

  const api = (path: string, init: RequestInit = {}) =>
    handleApi(ctx, new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: {
        cookie: `drives3_sid=${session.rawId}`,
        origin: ORIGIN,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.method && init.method !== "GET" ? { "x-csrf-token": session.csrfSecret } : {}),
      },
    }), `req_${crypto.randomUUID()}`);

  return { harness, ctx, user, auth, bucketId, api };
}

interface LockView {
  objectLockEnabled: boolean;
  objectLockDefault: { mode: string; days: number } | null;
  versioning: string;
}

describe("control-plane object lock", () => {
  test("is off by default", async () => {
    const { api, bucketId } = await setup();
    const view = unwrap<LockView>(await (await api(`/api/buckets/${bucketId}/access`)).json());
    expect(view.objectLockEnabled).toBe(false);
    expect(view.objectLockDefault).toBeNull();
  });

  test("enabling turns versioning on with it and cannot be undone", async () => {
    const { api, bucketId } = await setup();
    const res = await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ objectLockEnabled: true }),
    });
    expect(res.status).toBe(200);
    const view = unwrap<LockView>(await res.json());
    expect(view.objectLockEnabled).toBe(true);
    expect(view.versioning).toBe("Enabled");

    // There is no off switch: the field only ever accepts true, and sending
    // anything else leaves it enabled.
    const attempt = await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ objectLockEnabled: false }),
    });
    expect(unwrap<LockView>(await attempt.json()).objectLockEnabled).toBe(true);
  });

  test("enabling through the API really protects the data plane", async () => {
    const { harness, api, bucketId, auth } = await setup();
    await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ objectLockEnabled: true }),
    });

    const put = await harness.signAndSend({
      method: "PUT",
      path: "/vault/a.txt",
      headers: {
        "x-amz-object-lock-mode": "COMPLIANCE",
        "x-amz-object-lock-retain-until-date": FUTURE,
      },
      body: "protected",
      ...auth,
    });
    expect(put.status).toBe(200);
    const versionId = put.headers.get("x-amz-version-id")!;

    const blocked = await harness.signAndSend({
      method: "DELETE", path: "/vault/a.txt", query: { versionId }, ...auth,
    });
    expect(blocked.status).toBe(403);
  });

  test("a default retention can be set, reported, and cleared", async () => {
    const { api, bucketId } = await setup();
    await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ objectLockEnabled: true }),
    });

    const set = await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ objectLockDefault: { mode: "GOVERNANCE", days: 30 } }),
    });
    expect(unwrap<LockView>(await set.json()).objectLockDefault).toEqual({
      mode: "GOVERNANCE",
      days: 30,
    });

    const cleared = await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ objectLockDefault: null }),
    });
    expect(unwrap<LockView>(await cleared.json()).objectLockDefault).toBeNull();
  });

  test("a default retention applies to plain uploads", async () => {
    const { harness, api, bucketId, auth } = await setup();
    await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ objectLockEnabled: true }),
    });
    await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ objectLockDefault: { mode: "COMPLIANCE", days: 7 } }),
    });

    // No lock headers at all on this write.
    const put = await harness.signAndSend({
      method: "PUT", path: "/vault/auto.txt", body: "auto", ...auth,
    });
    const versionId = put.headers.get("x-amz-version-id")!;

    const blocked = await harness.signAndSend({
      method: "DELETE", path: "/vault/auto.txt", query: { versionId }, ...auth,
    });
    expect(blocked.status).toBe(403);
  });

  test("rejects a default retention on a bucket without object lock", async () => {
    const { api, bucketId } = await setup();
    const res = await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ objectLockDefault: { mode: "GOVERNANCE", days: 30 } }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects a malformed default retention", async () => {
    const { api, bucketId } = await setup();
    await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ objectLockEnabled: true }),
    });
    for (const value of [
      { mode: "LOOSE", days: 30 },
      { mode: "GOVERNANCE", days: 0 },
      { mode: "GOVERNANCE", days: -1 },
      { mode: "GOVERNANCE" },
      "nonsense",
    ]) {
      const res = await api(`/api/buckets/${bucketId}/access`, {
        method: "PUT",
        body: JSON.stringify({ objectLockDefault: value }),
      });
      expect(res.status).toBe(400);
    }
  });

  test("only the owner may enable object lock", async () => {
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

    const res = await handleApi(
      ctx,
      new Request(`${ORIGIN}/api/buckets/${bucketId}/access`, {
        method: "PUT",
        headers: {
          cookie: `drives3_sid=${session.rawId}`,
          origin: ORIGIN,
          "content-type": "application/json",
          "x-csrf-token": session.csrfSecret,
        },
        body: JSON.stringify({ objectLockEnabled: true }),
      }),
      "req_stranger",
    );
    expect(res.status).toBe(404);
  });
});
