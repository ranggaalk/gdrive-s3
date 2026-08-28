import { describe, expect, test } from "bun:test";
import { makeHarness } from "./_helpers.ts";

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const FURTHER = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
const SOONER = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

function retentionXml(mode: string, until: string): string {
  return `<Retention><Mode>${mode}</Mode><RetainUntilDate>${until}</RetainUntilDate></Retention>`;
}

function legalHoldXml(status: "ON" | "OFF"): string {
  return `<LegalHold><Status>${status}</Status></LegalHold>`;
}

/** A bucket created with Object Lock on, which implies versioning. */
async function setup() {
  const h = makeHarness();
  const user = h.seedUser("owner@x.com");
  const cred = h.seedCredential(user.id);
  const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
  const created = await h.signAndSend({
    method: "PUT",
    path: "/vault",
    headers: { "x-amz-bucket-object-lock-enabled": "true" },
    ...auth,
  });
  expect(created.status).toBe(200);
  return { h, user, auth };
}

function bucketId(h: ReturnType<typeof makeHarness>): string {
  return h.ctx.repos.buckets.listByName("vault")[0]!.id;
}

describe("enabling object lock", () => {
  test("creating with the header turns on lock and versioning together", async () => {
    const { h, auth } = await setup();
    const bucket = h.ctx.repos.buckets.listByName("vault")[0]!;
    expect(bucket.object_lock_enabled).toBe(1);
    // Object Lock is meaningless without versioning, so it implies it.
    expect(bucket.versioning).toBe("Enabled");

    const config = await h.signAndSend({
      method: "GET", path: "/vault", query: { "object-lock": "" }, ...auth,
    });
    expect(config.status).toBe(200);
    expect(await config.text()).toContain("<ObjectLockEnabled>Enabled</ObjectLockEnabled>");
  });

  test("a bucket without object lock reports none and rejects lock headers", async () => {
    const h = makeHarness();
    const user = h.seedUser("owner@x.com");
    const cred = h.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
    await h.signAndSend({ method: "PUT", path: "/plain", ...auth });

    expect((await h.signAndSend({
      method: "GET", path: "/plain", query: { "object-lock": "" }, ...auth,
    })).status).toBe(404);

    const res = await h.signAndSend({
      method: "PUT",
      path: "/plain/a.txt",
      headers: {
        "x-amz-object-lock-mode": "GOVERNANCE",
        "x-amz-object-lock-retain-until-date": FUTURE,
      },
      body: "x",
      ...auth,
    });
    expect(res.status).toBe(400);
  });

  test("can be enabled after the fact through ?object-lock", async () => {
    const h = makeHarness();
    const user = h.seedUser("owner@x.com");
    const cred = h.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
    await h.signAndSend({ method: "PUT", path: "/later", ...auth });

    const res = await h.signAndSend({
      method: "PUT",
      path: "/later",
      query: { "object-lock": "" },
      body: "<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>",
      ...auth,
    });
    expect(res.status).toBe(200);
    const bucket = h.ctx.repos.buckets.listByName("later")[0]!;
    expect(bucket.object_lock_enabled).toBe(1);
    expect(bucket.versioning).toBe("Enabled");
  });
});

describe("GOVERNANCE retention", () => {
  test("blocks deleting the version and yields to an owner bypass", async () => {
    const { h, auth } = await setup();
    const put = await h.signAndSend({
      method: "PUT",
      path: "/vault/g.txt",
      headers: {
        "x-amz-object-lock-mode": "GOVERNANCE",
        "x-amz-object-lock-retain-until-date": FUTURE,
      },
      body: "protected",
      ...auth,
    });
    expect(put.status).toBe(200);
    const versionId = put.headers.get("x-amz-version-id")!;

    const blocked = await h.signAndSend({
      method: "DELETE", path: "/vault/g.txt", query: { versionId }, ...auth,
    });
    expect(blocked.status).toBe(403);
    // The data is still there.
    expect(await (await h.signAndSend({
      method: "GET", path: "/vault/g.txt", query: { versionId }, ...auth,
    })).text()).toBe("protected");

    const bypassed = await h.signAndSend({
      method: "DELETE",
      path: "/vault/g.txt",
      query: { versionId },
      headers: { "x-amz-bypass-governance-retention": "true" },
      ...auth,
    });
    expect(bypassed.status).toBe(204);
  });

  test("a bypass from a non-owner is refused", async () => {
    const { h, auth } = await setup();
    const put = await h.signAndSend({
      method: "PUT",
      path: "/vault/g.txt",
      headers: {
        "x-amz-object-lock-mode": "GOVERNANCE",
        "x-amz-object-lock-retain-until-date": FUTURE,
      },
      body: "protected",
      ...auth,
    });
    const versionId = put.headers.get("x-amz-version-id")!;

    // Grant a second user write access via a bucket policy, then let them try.
    const other = h.seedUser("eric@x.com");
    const otherCred = h.seedCredential(other.id);
    await h.signAndSend({
      method: "PUT",
      path: "/vault",
      query: { policy: "" },
      body: JSON.stringify({
        Statement: [{
          Effect: "Allow",
          Principal: { AWS: "arn:aws:iam:::user/eric@x.com" },
          Action: ["s3:GetObject", "s3:DeleteObject"],
          Resource: "arn:aws:s3:::vault/*",
        }],
      }),
      ...auth,
    });

    const res = await h.signAndSend({
      method: "DELETE",
      path: "/vault/g.txt",
      query: { versionId },
      headers: { "x-amz-bypass-governance-retention": "true" },
      accessKeyId: otherCred.accessKeyId,
      secretAccessKey: otherCred.secretAccessKey,
    });
    expect(res.status).toBe(403);
  });
});

describe("COMPLIANCE retention", () => {
  test("can never be bypassed, even by the bucket owner", async () => {
    const { h, auth } = await setup();
    const put = await h.signAndSend({
      method: "PUT",
      path: "/vault/c.txt",
      headers: {
        "x-amz-object-lock-mode": "COMPLIANCE",
        "x-amz-object-lock-retain-until-date": FUTURE,
      },
      body: "immutable",
      ...auth,
    });
    const versionId = put.headers.get("x-amz-version-id")!;

    const attempts: Array<Record<string, string>> = [
      {},
      { "x-amz-bypass-governance-retention": "true" },
    ];
    for (const headers of attempts) {
      const res = await h.signAndSend({
        method: "DELETE", path: "/vault/c.txt", query: { versionId }, headers, ...auth,
      });
      expect(res.status).toBe(403);
    }
    expect(await (await h.signAndSend({
      method: "GET", path: "/vault/c.txt", query: { versionId }, ...auth,
    })).text()).toBe("immutable");
  });

  test("cannot be shortened or downgraded to GOVERNANCE", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({
      method: "PUT",
      path: "/vault/c.txt",
      headers: {
        "x-amz-object-lock-mode": "COMPLIANCE",
        "x-amz-object-lock-retain-until-date": FUTURE,
      },
      body: "immutable",
      ...auth,
    });

    const shorter = await h.signAndSend({
      method: "PUT", path: "/vault/c.txt", query: { retention: "" },
      headers: { "x-amz-bypass-governance-retention": "true" },
      body: retentionXml("COMPLIANCE", SOONER), ...auth,
    });
    expect(shorter.status).toBe(403);

    const downgrade = await h.signAndSend({
      method: "PUT", path: "/vault/c.txt", query: { retention: "" },
      body: retentionXml("GOVERNANCE", FURTHER), ...auth,
    });
    expect(downgrade.status).toBe(403);
  });

  test("may still be extended", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({
      method: "PUT",
      path: "/vault/c.txt",
      headers: {
        "x-amz-object-lock-mode": "COMPLIANCE",
        "x-amz-object-lock-retain-until-date": FUTURE,
      },
      body: "immutable",
      ...auth,
    });
    const res = await h.signAndSend({
      method: "PUT", path: "/vault/c.txt", query: { retention: "" },
      body: retentionXml("COMPLIANCE", FURTHER), ...auth,
    });
    expect(res.status).toBe(200);

    const read = await h.signAndSend({
      method: "GET", path: "/vault/c.txt", query: { retention: "" }, ...auth,
    });
    expect(await read.text()).toContain(FURTHER);
  });
});

describe("legal hold", () => {
  test("blocks deletion and can be lifted again", async () => {
    const { h, auth } = await setup();
    const put = await h.signAndSend({
      method: "PUT", path: "/vault/h.txt", body: "held", ...auth,
    });
    const versionId = put.headers.get("x-amz-version-id")!;

    const on = await h.signAndSend({
      method: "PUT", path: "/vault/h.txt", query: { "legal-hold": "" },
      body: legalHoldXml("ON"), ...auth,
    });
    expect(on.status).toBe(200);

    const blocked = await h.signAndSend({
      method: "DELETE", path: "/vault/h.txt", query: { versionId }, ...auth,
    });
    expect(blocked.status).toBe(403);

    // A bypass does not apply to a legal hold.
    const stillBlocked = await h.signAndSend({
      method: "DELETE", path: "/vault/h.txt", query: { versionId },
      headers: { "x-amz-bypass-governance-retention": "true" }, ...auth,
    });
    expect(stillBlocked.status).toBe(403);

    await h.signAndSend({
      method: "PUT", path: "/vault/h.txt", query: { "legal-hold": "" },
      body: legalHoldXml("OFF"), ...auth,
    });
    const allowed = await h.signAndSend({
      method: "DELETE", path: "/vault/h.txt", query: { versionId }, ...auth,
    });
    expect(allowed.status).toBe(204);
  });

  test("reports its status", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({ method: "PUT", path: "/vault/h.txt", body: "x", ...auth });

    const off = await h.signAndSend({
      method: "GET", path: "/vault/h.txt", query: { "legal-hold": "" }, ...auth,
    });
    expect(await off.text()).toContain("<Status>OFF</Status>");

    await h.signAndSend({
      method: "PUT", path: "/vault/h.txt", query: { "legal-hold": "" },
      body: legalHoldXml("ON"), ...auth,
    });
    const on = await h.signAndSend({
      method: "GET", path: "/vault/h.txt", query: { "legal-hold": "" }, ...auth,
    });
    expect(await on.text()).toContain("<Status>ON</Status>");
  });

  test("set at write time via the header", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({
      method: "PUT", path: "/vault/h.txt",
      headers: { "x-amz-object-lock-legal-hold": "ON" },
      body: "born held", ...auth,
    });
    const status = await h.signAndSend({
      method: "GET", path: "/vault/h.txt", query: { "legal-hold": "" }, ...auth,
    });
    expect(await status.text()).toContain("<Status>ON</Status>");
  });
});

describe("bucket default retention", () => {
  test("applies to writes that name no lock of their own", async () => {
    const { h, auth } = await setup();
    const config = await h.signAndSend({
      method: "PUT",
      path: "/vault",
      query: { "object-lock": "" },
      body:
        "<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled>" +
        "<Rule><DefaultRetention><Mode>GOVERNANCE</Mode><Days>30</Days></DefaultRetention></Rule>" +
        "</ObjectLockConfiguration>",
      ...auth,
    });
    expect(config.status).toBe(200);

    const put = await h.signAndSend({ method: "PUT", path: "/vault/d.txt", body: "auto", ...auth });
    const versionId = put.headers.get("x-amz-version-id")!;

    const retention = await h.signAndSend({
      method: "GET", path: "/vault/d.txt", query: { retention: "" }, ...auth,
    });
    expect(retention.status).toBe(200);
    expect(await retention.text()).toContain("<Mode>GOVERNANCE</Mode>");

    // And it really protects the object.
    expect((await h.signAndSend({
      method: "DELETE", path: "/vault/d.txt", query: { versionId }, ...auth,
    })).status).toBe(403);
  });

  test("an explicit header overrides the default", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({
      method: "PUT", path: "/vault", query: { "object-lock": "" },
      body:
        "<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled>" +
        "<Rule><DefaultRetention><Mode>GOVERNANCE</Mode><Days>30</Days></DefaultRetention></Rule>" +
        "</ObjectLockConfiguration>",
      ...auth,
    });
    await h.signAndSend({
      method: "PUT", path: "/vault/o.txt",
      headers: {
        "x-amz-object-lock-mode": "COMPLIANCE",
        "x-amz-object-lock-retain-until-date": FUTURE,
      },
      body: "explicit", ...auth,
    });
    const retention = await h.signAndSend({
      method: "GET", path: "/vault/o.txt", query: { retention: "" }, ...auth,
    });
    expect(await retention.text()).toContain("<Mode>COMPLIANCE</Mode>");
  });
});

describe("locks and versioning together", () => {
  test("a lock survives being superseded by a newer write", async () => {
    const { h, auth } = await setup();
    const first = await h.signAndSend({
      method: "PUT", path: "/vault/v.txt",
      headers: {
        "x-amz-object-lock-mode": "COMPLIANCE",
        "x-amz-object-lock-retain-until-date": FUTURE,
      },
      body: "locked v1", ...auth,
    });
    const v1 = first.headers.get("x-amz-version-id")!;

    // Overwriting is allowed; it creates a new version rather than destroying
    // the locked one.
    const second = await h.signAndSend({ method: "PUT", path: "/vault/v.txt", body: "v2", ...auth });
    expect(second.status).toBe(200);

    // The archived version carried its lock with it.
    const archived = h.ctx.repos.objectVersions.find(bucketId(h), "v.txt", v1)!;
    expect(archived.lock_mode).toBe("COMPLIANCE");
    expect((await h.signAndSend({
      method: "DELETE", path: "/vault/v.txt", query: { versionId: v1 }, ...auth,
    })).status).toBe(403);
  });

  test("a delete marker is still allowed over a locked current version", async () => {
    const { h, auth } = await setup();
    const put = await h.signAndSend({
      method: "PUT", path: "/vault/m.txt",
      headers: {
        "x-amz-object-lock-mode": "COMPLIANCE",
        "x-amz-object-lock-retain-until-date": FUTURE,
      },
      body: "locked", ...auth,
    });
    const v1 = put.headers.get("x-amz-version-id")!;

    // A marker hides the key without destroying bytes, so retention permits it.
    const del = await h.signAndSend({ method: "DELETE", path: "/vault/m.txt", ...auth });
    expect(del.status).toBe(204);
    expect(del.headers.get("x-amz-delete-marker")).toBe("true");

    // The locked version is untouched underneath.
    expect(await (await h.signAndSend({
      method: "GET", path: "/vault/m.txt", query: { versionId: v1 }, ...auth,
    })).text()).toBe("locked");
  });

  test("a locked version is excluded from the bulk prune", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({
      method: "PUT", path: "/vault/p.txt",
      headers: {
        "x-amz-object-lock-mode": "COMPLIANCE",
        "x-amz-object-lock-retain-until-date": FUTURE,
      },
      body: "locked v1", ...auth,
    });
    await h.signAndSend({ method: "PUT", path: "/vault/p.txt", body: "v2", ...auth });
    await h.signAndSend({ method: "PUT", path: "/vault/p.txt", body: "v3", ...auth });

    // Bulk pruning must not become the way a retention guarantee is bypassed.
    const prunable = h.ctx.repos.objectVersions.listNonCurrent(bucketId(h));
    expect(prunable.every((version) => version.lock_mode === null)).toBe(true);
    expect(prunable).toHaveLength(1);
  });
});

describe("deleting an unversioned locked object", () => {
  test("is refused when the bytes would really be destroyed", async () => {
    const h = makeHarness();
    const user = h.seedUser("owner@x.com");
    const cred = h.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
    await h.signAndSend({
      method: "PUT", path: "/vault",
      headers: { "x-amz-bucket-object-lock-enabled": "true" }, ...auth,
    });
    await h.signAndSend({
      method: "PUT", path: "/vault/s.txt",
      headers: {
        "x-amz-object-lock-mode": "COMPLIANCE",
        "x-amz-object-lock-retain-until-date": FUTURE,
      },
      body: "locked", ...auth,
    });

    // Suspend versioning so a plain DELETE would destroy the bytes outright.
    await h.signAndSend({
      method: "PUT", path: "/vault", query: { versioning: "" },
      body: "<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>",
      ...auth,
    });

    const res = await h.signAndSend({ method: "DELETE", path: "/vault/s.txt", ...auth });
    expect(res.status).toBe(403);
    expect(await (await h.signAndSend({ method: "GET", path: "/vault/s.txt", ...auth })).text())
      .toBe("locked");
  });
});
