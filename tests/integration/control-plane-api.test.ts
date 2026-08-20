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

describe("control-plane public S3 configuration", () => {
  test("status and credential creation use the configured endpoint and region", async () => {
    const harness = makeHarness({
      appOrigin: "http://localhost:5173",
      s3PublicEndpoint: "http://localhost:3000",
      s3Region: "ap-southeast-3",
    });
    const { ctx, seedUser } = harness;
    ctxToClose = ctx;
    const user = seedUser("docs@example.com");
    const session = ctx.sessionService.establish({ userId: user.id, userAgent: "test", ip: null });
    const cookie = `drives3_sid=${session.rawId}`;

    const statusResponse = await handleApi(
      ctx,
      new Request("http://localhost:5173/api/status", { headers: { cookie } }),
      "req-status",
    );
    expect(statusResponse.status).toBe(200);
    const status = unwrap<Record<string, unknown>>(await statusResponse.json());
    expect(status.s3Endpoint).toBe("http://localhost:3000");
    expect(status.s3Region).toBe("ap-southeast-3");
    expect(status).not.toHaveProperty("masterEncryptionKey");
    expect(status).not.toHaveProperty("sessionSecret");

    const createResponse = await handleApi(
      ctx,
      new Request("http://localhost:5173/api/credentials", {
        method: "POST",
        headers: {
          cookie,
          origin: "http://localhost:5173",
          "content-type": "application/json",
          "x-csrf-token": session.csrfSecret,
        },
        body: JSON.stringify({ label: "documentation test" }),
      }),
      "req-create",
    );
    expect(createResponse.status).toBe(201);
    const created = unwrap<Record<string, unknown>>(await createResponse.json());
    expect(created.s3Endpoint).toBe("http://localhost:3000");
    expect(created.s3Region).toBe("ap-southeast-3");
    expect(String(created.accessKeyId)).toHaveLength(20);
    expect(String(created.secretAccessKey)).toHaveLength(40);

    const listResponse = await handleApi(
      ctx,
      new Request("http://localhost:5173/api/credentials", { headers: { cookie } }),
      "req-list",
    );
    const listed = unwrap<Array<Record<string, unknown>>>(await listResponse.json());
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("secretAccessKey");
    expect(listed[0]).not.toHaveProperty("encrypted_secret_key");
  });

  test("rotates, revokes, and permanently deletes credentials", async () => {
    const harness = makeHarness();
    const { ctx, seedUser } = harness;
    ctxToClose = ctx;
    const user = seedUser("lifecycle@example.com");
    const session = ctx.sessionService.establish({ userId: user.id, userAgent: "test", ip: null });
    const headers = {
      cookie: `drives3_sid=${session.rawId}`,
      origin: "http://localhost",
      "content-type": "application/json",
      "x-csrf-token": session.csrfSecret,
    };
    const createdResponse = await handleApi(ctx, new Request("http://localhost/api/credentials", {
      method: "POST", headers, body: JSON.stringify({ label: "client" }),
    }), "req-create-lifecycle");
    expect(createdResponse.headers.get("cache-control")).toBe("no-store");
    const created = unwrap<Record<string, string>>(await createdResponse.json());

    const rotateResponse = await handleApi(ctx, new Request(
      `http://localhost/api/credentials/${created.id}/rotate`, { method: "POST", headers },
    ), "req-rotate-lifecycle");
    expect(rotateResponse.status).toBe(201);
    expect(rotateResponse.headers.get("cache-control")).toBe("no-store");
    const rotated = unwrap<Record<string, string>>(await rotateResponse.json());
    expect(rotated.accessKeyId).not.toBe(created.accessKeyId);

    const revokeResponse = await handleApi(ctx, new Request(
      `http://localhost/api/credentials/${rotated.id}/revoke`, { method: "POST", headers },
    ), "req-revoke-lifecycle");
    expect(revokeResponse.status).toBe(200);
    const deleteResponse = await handleApi(ctx, new Request(
      `http://localhost/api/credentials/${rotated.id}`, { method: "DELETE", headers },
    ), "req-delete-lifecycle");
    expect(deleteResponse.status).toBe(200);
    expect(ctx.repos.credentials.findByIdOwned(user.id, rotated.id!)).toBeNull();
  });

  test("creates a Shared Drive bucket and grants selected member access", async () => {
    const harness = makeHarness();
    const { ctx, seedUser, storage } = harness;
    ctxToClose = ctx;
    const owner = seedUser("owner@x.com");
    const viewer = seedUser("viewer@x.com");
    storage.registerSharedDrive({
      id: "drive-finance",
      name: "Finance",
      members: [
        { userId: owner.id, canWrite: true },
        { userId: viewer.id, canWrite: false },
      ],
    });
    const session = ctx.sessionService.establish({
      userId: owner.id,
      userAgent: "test",
      ip: null,
    });
    const cookie = `drives3_sid=${session.rawId}`;
    const headers = {
      cookie,
      origin: "http://localhost",
      "content-type": "application/json",
      "x-csrf-token": session.csrfSecret,
    };

    const create = await handleApi(
      ctx,
      new Request("http://localhost/api/buckets", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "finance-reports",
          storage: { kind: "shared_drive", driveId: "drive-finance" },
        }),
      }),
      "req-shared-create",
    );
    expect(create.status).toBe(201);
    const bucket = unwrap<Record<string, unknown>>(await create.json());
    expect(bucket.storageKind).toBe("shared_drive");
    expect(bucket.storageDisplayName).toBe("Finance");

    const add = await handleApi(
      ctx,
      new Request(`http://localhost/api/buckets/${bucket.id}/members`, {
        method: "POST",
        headers,
        body: JSON.stringify({ email: "viewer@x.com", role: "viewer" }),
      }),
      "req-member-add",
    );
    expect(add.status).toBe(201);
    expect(
      ctx.repos.buckets.findAccessibleByName(viewer.id, "finance-reports")?.effective_role,
    ).toBe("viewer");
  });
});
