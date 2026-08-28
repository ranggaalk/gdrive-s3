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

async function setup() {
  const harness = makeHarness({ appOrigin: ORIGIN });
  const { ctx, seedUser, seedCredential } = harness;
  ctxToClose = ctx;
  const user = seedUser("owner@x.com");
  const cred = seedCredential(user.id);
  const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
  await harness.signAndSend({ method: "PUT", path: "/docs", ...auth });

  const session = ctx.sessionService.establish({ userId: user.id, userAgent: "test", ip: null });
  const bucketId = ctx.repos.buckets.listByName("docs")[0]!.id;

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

interface AccessView {
  versioning: string;
  retainedVersions: number;
}

interface VersionView {
  versionId: string;
  isLatest: boolean;
  isDeleteMarker: boolean;
  size: number;
}

describe("control-plane versioning", () => {
  test("reports Disabled and no retained versions by default", async () => {
    const { api, bucketId } = await setup();
    const view = unwrap<AccessView>(await (await api(`/api/buckets/${bucketId}/access`)).json());
    expect(view.versioning).toBe("Disabled");
    expect(view.retainedVersions).toBe(0);
  });

  test("enabling through the API really versions the data plane", async () => {
    const { harness, api, bucketId, auth } = await setup();
    const res = await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ versioning: "Enabled" }),
    });
    expect(res.status).toBe(200);
    expect(unwrap<AccessView>(await res.json()).versioning).toBe("Enabled");

    const first = await harness.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v1", ...auth });
    expect(first.headers.get("x-amz-version-id")).toBeTruthy();
    await harness.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v2", ...auth });

    const after = unwrap<AccessView>(await (await api(`/api/buckets/${bucketId}/access`)).json());
    expect(after.retainedVersions).toBe(1);
  });

  test("rejects a versioning value S3 would not accept", async () => {
    const { api, bucketId } = await setup();
    const res = await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ versioning: "Disabled" }),
    });
    expect(res.status).toBe(400);
  });

  test("lists an object's versions with the current one first", async () => {
    const { harness, api, bucketId, auth } = await setup();
    await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ versioning: "Enabled" }),
    });
    await harness.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v1", ...auth });
    await harness.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v2", ...auth });

    const objectId = harness.ctx.repos.objects.findByKey(bucketId, "a.txt")!.id;
    const versions = unwrap<VersionView[]>(
      await (await api(`/api/buckets/${bucketId}/objects/${objectId}/versions`)).json(),
    );
    expect(versions).toHaveLength(2);
    expect(versions[0]!.isLatest).toBe(true);
    expect(versions[1]!.isLatest).toBe(false);
  });

  test("deleting one version through the API leaves the current one intact", async () => {
    const { harness, api, bucketId, auth } = await setup();
    await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ versioning: "Enabled" }),
    });
    const first = await harness.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v1", ...auth });
    const v1 = first.headers.get("x-amz-version-id")!;
    await harness.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v2", ...auth });

    const objectId = harness.ctx.repos.objects.findByKey(bucketId, "a.txt")!.id;
    const res = await api(`/api/buckets/${bucketId}/objects/${objectId}/versions/${v1}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    expect((await harness.signAndSend({
      method: "GET", path: "/docs/a.txt", query: { versionId: v1 }, ...auth,
    })).status).toBe(404);
    expect(await (await harness.signAndSend({ method: "GET", path: "/docs/a.txt", ...auth })).text())
      .toBe("v2");
  });

  test("pruning removes retained versions and frees their Drive files", async () => {
    const { harness, api, bucketId, auth } = await setup();
    await api(`/api/buckets/${bucketId}/access`, {
      method: "PUT",
      body: JSON.stringify({ versioning: "Enabled" }),
    });
    const first = await harness.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v1", ...auth });
    const v1 = first.headers.get("x-amz-version-id")!;
    await harness.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v2", ...auth });
    await harness.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v3", ...auth });

    const archived = harness.ctx.repos.objectVersions.find(bucketId, "a.txt", v1)!;
    const res = await api(`/api/buckets/${bucketId}/versions`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(unwrap<{ removed: number }>(await res.json()).removed).toBe(2);

    // The bytes are queued for release, not silently orphaned.
    const queued = harness.ctx.repos.pendingCleanup.due(
      new Date(Date.now() + 1000).toISOString(),
      50,
    );
    expect(queued.some((row) => row.resource_id === archived.drive_file_id)).toBe(true);

    // The current version is untouched.
    expect(await (await harness.signAndSend({ method: "GET", path: "/docs/a.txt", ...auth })).text())
      .toBe("v3");
    expect(unwrap<AccessView>(await (await api(`/api/buckets/${bucketId}/access`)).json())
      .retainedVersions).toBe(0);
  });

  test("only the owner may change versioning or prune", async () => {
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
    const headers = {
      cookie: `drives3_sid=${session.rawId}`,
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": session.csrfSecret,
    };

    const toggle = await handleApi(
      ctx,
      new Request(`${ORIGIN}/api/buckets/${bucketId}/access`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ versioning: "Enabled" }),
      }),
      "req_stranger_toggle",
    );
    expect(toggle.status).toBe(404);

    const prune = await handleApi(
      ctx,
      new Request(`${ORIGIN}/api/buckets/${bucketId}/versions`, { method: "DELETE", headers }),
      "req_stranger_prune",
    );
    expect(prune.status).toBe(404);
  });
});
