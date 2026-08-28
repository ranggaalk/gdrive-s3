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

function setup() {
  const harness = makeHarness({ appOrigin: ORIGIN });
  const { ctx, seedUser } = harness;
  ctxToClose = ctx;
  const user = seedUser("owner@x.com");
  const session = ctx.sessionService.establish({ userId: user.id, userAgent: "test", ip: null });

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

  return { harness, ctx, user, api };
}

interface KeyView {
  id: string;
  alias: string;
  version: number;
  status: string;
  objectCount: number;
  rotatedAt: string | null;
}

describe("control-plane KMS keys", () => {
  test("starts empty and creates a key", async () => {
    const { api } = setup();
    expect(unwrap<KeyView[]>(await (await api("/api/security/kms")).json())).toEqual([]);

    const res = await api("/api/security/kms", {
      method: "POST",
      body: JSON.stringify({ alias: "records" }),
    });
    expect(res.status).toBe(201);
    const created = unwrap<KeyView>(await res.json());
    expect(created).toMatchObject({ alias: "records", version: 1, status: "active", objectCount: 0 });
  });

  test("never exposes key material in any form", async () => {
    const { api } = setup();
    await api("/api/security/kms", { method: "POST", body: JSON.stringify({ alias: "secret" }) });
    const body = await (await api("/api/security/kms")).text();
    expect(body).not.toContain("encrypted_material");
    expect(body).not.toContain("ciphertext");
  });

  test("rejects a duplicate alias and a malformed one", async () => {
    const { api } = setup();
    await api("/api/security/kms", { method: "POST", body: JSON.stringify({ alias: "dup" }) });
    const conflict = await api("/api/security/kms", {
      method: "POST",
      body: JSON.stringify({ alias: "dup" }),
    });
    expect(conflict.status).toBe(409);

    for (const alias of ["", "has space", "/leading", "x".repeat(200)]) {
      const bad = await api("/api/security/kms", {
        method: "POST",
        body: JSON.stringify({ alias }),
      });
      expect(bad.status).toBe(400);
    }
  });

  test("rotation bumps the version and is reflected in the listing", async () => {
    const { api } = setup();
    const created = unwrap<KeyView>(
      await (await api("/api/security/kms", {
        method: "POST",
        body: JSON.stringify({ alias: "rotating" }),
      })).json(),
    );

    const rotated = unwrap<KeyView>(
      await (await api(`/api/security/kms/${created.id}/rotate`, { method: "POST" })).json(),
    );
    expect(rotated.version).toBe(2);
    expect(rotated.rotatedAt).toBeTruthy();

    const listed = unwrap<KeyView[]>(await (await api("/api/security/kms")).json());
    expect(listed[0]!.version).toBe(2);
  });

  test("status can be toggled and blocks new encrypted writes while disabled", async () => {
    const { harness, api, user } = setup();
    const created = unwrap<KeyView>(
      await (await api("/api/security/kms", {
        method: "POST",
        body: JSON.stringify({ alias: "toggle" }),
      })).json(),
    );

    const cred = harness.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
    await harness.signAndSend({ method: "PUT", path: "/vault", ...auth });

    const disabled = await api(`/api/security/kms/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "disabled" }),
    });
    expect(unwrap<KeyView>(await disabled.json()).status).toBe("disabled");

    const blocked = await harness.signAndSend({
      method: "PUT",
      path: "/vault/x.txt",
      headers: {
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": created.id,
      },
      body: "x",
      ...auth,
    });
    expect(blocked.status).toBe(400);

    await api(`/api/security/kms/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "active" }),
    });
    const allowed = await harness.signAndSend({
      method: "PUT",
      path: "/vault/x.txt",
      headers: {
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": created.id,
      },
      body: "x",
      ...auth,
    });
    expect(allowed.status).toBe(200);
  });

  test("objectCount reflects real usage", async () => {
    const { harness, api, user } = setup();
    const created = unwrap<KeyView>(
      await (await api("/api/security/kms", {
        method: "POST",
        body: JSON.stringify({ alias: "counted" }),
      })).json(),
    );

    const cred = harness.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
    await harness.signAndSend({ method: "PUT", path: "/vault", ...auth });
    await harness.signAndSend({
      method: "PUT",
      path: "/vault/counted.txt",
      headers: {
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": created.id,
      },
      body: "counted",
      ...auth,
    });

    const listed = unwrap<KeyView[]>(await (await api("/api/security/kms")).json());
    expect(listed.find((k) => k.id === created.id)!.objectCount).toBe(1);
  });

  test("another user's keys are invisible and untouchable", async () => {
    const { ctx, api } = setup();
    const created = unwrap<KeyView>(
      await (await api("/api/security/kms", {
        method: "POST",
        body: JSON.stringify({ alias: "mine" }),
      })).json(),
    );

    const stranger = ctx.repos.users.upsertOnLogin({
      googleSub: "sub-stranger",
      email: "stranger@x.com",
      displayName: null,
      hostedDomain: "x.com",
    });
    const session = ctx.sessionService.establish({
      userId: stranger.id, userAgent: "test", ip: null,
    });
    const headers = {
      cookie: `drives3_sid=${session.rawId}`,
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": session.csrfSecret,
    };

    const listed = unwrap<KeyView[]>(
      await (await handleApi(
        ctx,
        new Request(`${ORIGIN}/api/security/kms`, { headers }),
        "req_stranger_list",
      )).json(),
    );
    expect(listed).toEqual([]);

    const rotate = await handleApi(
      ctx,
      new Request(`${ORIGIN}/api/security/kms/${created.id}/rotate`, { method: "POST", headers }),
      "req_stranger_rotate",
    );
    expect(rotate.status).toBe(404);
  });

  test("bucket default encryption round-trips through the access endpoint", async () => {
    const { harness, api, user } = setup();
    const created = unwrap<KeyView>(
      await (await api("/api/security/kms", {
        method: "POST",
        body: JSON.stringify({ alias: "bucket-default" }),
      })).json(),
    );

    const cred = harness.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
    await harness.signAndSend({ method: "PUT", path: "/vault", ...auth });
    const bucketId = harness.ctx.repos.buckets.listByName("vault")[0]!.id;

    const set = await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ defaultSseAlgorithm: "aws:kms", defaultKmsKeyId: created.id }),
    });
    expect(set.status).toBe(200);
    expect(unwrap<Record<string, unknown>>(await set.json())).toMatchObject({
      defaultSseAlgorithm: "aws:kms",
      defaultKmsKeyId: created.id,
    });

    // A plain upload now lands encrypted.
    const put = await harness.signAndSend({
      method: "PUT", path: "/vault/auto.txt", body: "auto", ...auth,
    });
    expect(put.headers.get("x-amz-server-side-encryption")).toBe("aws:kms");

    const cleared = await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ defaultSseAlgorithm: null }),
    });
    expect(unwrap<Record<string, unknown>>(await cleared.json()).defaultSseAlgorithm).toBeNull();
  });

  test("a default naming an unknown key is refused", async () => {
    const { harness, api, user } = setup();
    const cred = harness.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
    await harness.signAndSend({ method: "PUT", path: "/vault", ...auth });
    const bucketId = harness.ctx.repos.buckets.listByName("vault")[0]!.id;

    const res = await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ defaultSseAlgorithm: "aws:kms", defaultKmsKeyId: "kms_missing" }),
    });
    expect(res.status).toBe(404);
  });
});
