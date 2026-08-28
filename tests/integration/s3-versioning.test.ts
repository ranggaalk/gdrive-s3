import { describe, expect, test } from "bun:test";
import { makeHarness } from "./_helpers.ts";

const ENABLE = "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>";
const SUSPEND = "<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>";

async function setup(enable = true) {
  const h = makeHarness();
  const user = h.seedUser("owner@x.com");
  const cred = h.seedCredential(user.id);
  const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
  await h.signAndSend({ method: "PUT", path: "/docs", ...auth });
  if (enable) {
    const res = await h.signAndSend({
      method: "PUT", path: "/docs", query: { versioning: "" }, body: ENABLE, ...auth,
    });
    expect(res.status).toBe(200);
  }
  return { h, user, auth };
}

function bucketId(h: ReturnType<typeof makeHarness>): string {
  return h.ctx.repos.buckets.listByName("docs")[0]!.id;
}

describe("versioning configuration", () => {
  test("reports empty until enabled, then reflects the status", async () => {
    const { h, auth } = await setup(false);
    const before = await h.signAndSend({
      method: "GET", path: "/docs", query: { versioning: "" }, ...auth,
    });
    expect(before.status).toBe(200);
    expect(await before.text()).not.toContain("<Status>");

    await h.signAndSend({
      method: "PUT", path: "/docs", query: { versioning: "" }, body: ENABLE, ...auth,
    });
    const after = await h.signAndSend({
      method: "GET", path: "/docs", query: { versioning: "" }, ...auth,
    });
    expect(await after.text()).toContain("<Status>Enabled</Status>");
  });

  test("rejects a status that is not Enabled or Suspended", async () => {
    const { h, auth } = await setup(false);
    const res = await h.signAndSend({
      method: "PUT", path: "/docs", query: { versioning: "" },
      body: "<VersioningConfiguration><Status>Disabled</Status></VersioningConfiguration>",
      ...auth,
    });
    expect(res.status).toBe(400);
  });
});

describe("a bucket with versioning disabled behaves exactly as before", () => {
  test("overwrite replaces in place and leaves no versions", async () => {
    const { h, auth } = await setup(false);
    await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v1", ...auth });
    const put = await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v2", ...auth });
    expect(put.headers.has("x-amz-version-id")).toBe(false);

    expect(await (await h.signAndSend({ method: "GET", path: "/docs/a.txt", ...auth })).text())
      .toBe("v2");
    expect(h.ctx.repos.objectVersions.countForBucket(bucketId(h))).toBe(0);
  });

  test("delete really deletes, with no marker left behind", async () => {
    const { h, auth } = await setup(false);
    await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v1", ...auth });
    const del = await h.signAndSend({ method: "DELETE", path: "/docs/a.txt", ...auth });
    expect(del.status).toBe(204);
    expect(del.headers.has("x-amz-delete-marker")).toBe(false);
    expect(h.ctx.repos.objectVersions.countForBucket(bucketId(h))).toBe(0);
  });
});

describe("versioned writes", () => {
  test("each overwrite retains the previous version", async () => {
    const { h, auth } = await setup();

    const first = await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v1", ...auth });
    const v1 = first.headers.get("x-amz-version-id")!;
    expect(v1).toBeTruthy();

    const second = await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v2", ...auth });
    const v2 = second.headers.get("x-amz-version-id")!;
    expect(v2).not.toBe(v1);

    // The key resolves to the newest write.
    const current = await h.signAndSend({ method: "GET", path: "/docs/a.txt", ...auth });
    expect(await current.text()).toBe("v2");
    expect(current.headers.get("x-amz-version-id")).toBe(v2);

    // The superseded one is still readable by id.
    const old = await h.signAndSend({
      method: "GET", path: "/docs/a.txt", query: { versionId: v1 }, ...auth,
    });
    expect(old.status).toBe(200);
    expect(await old.text()).toBe("v1");
    expect(old.headers.get("x-amz-version-id")).toBe(v1);
  });

  test("an overwrite does not destroy the old version's bytes", async () => {
    const { h, auth } = await setup();
    const first = await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "keep me", ...auth });
    const v1 = first.headers.get("x-amz-version-id")!;
    await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "newer", ...auth });

    // Nothing was queued for deletion, which is what would have destroyed it.
    const archived = h.ctx.repos.objectVersions.find(bucketId(h), "a.txt", v1)!;
    expect(archived.drive_file_id).toBeTruthy();
    expect(h.storage.contentOf(archived.drive_file_id!)).toBeTruthy();
    expect(await (await h.signAndSend({
      method: "GET", path: "/docs/a.txt", query: { versionId: v1 }, ...auth,
    })).text()).toBe("keep me");
  });

  test("Suspended writes the null version id but keeps existing versions", async () => {
    const { h, auth } = await setup();
    const first = await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v1", ...auth });
    const v1 = first.headers.get("x-amz-version-id")!;

    await h.signAndSend({
      method: "PUT", path: "/docs", query: { versioning: "" }, body: SUSPEND, ...auth,
    });
    const suspended = await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v2", ...auth });
    expect(suspended.headers.has("x-amz-version-id")).toBe(false);

    // The earlier version survives the suspension.
    expect(await (await h.signAndSend({
      method: "GET", path: "/docs/a.txt", query: { versionId: v1 }, ...auth,
    })).text()).toBe("v1");
  });

  test("a suspended overwrite does not destroy a retained version's bytes", async () => {
    const { h, auth } = await setup();
    const first = await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "keep", ...auth });
    const v1 = first.headers.get("x-amz-version-id")!;

    await h.signAndSend({
      method: "PUT", path: "/docs", query: { versioning: "" }, body: SUSPEND, ...auth,
    });
    // Two suspended writes: the second replaces the first null version, but
    // neither may touch the version created while versioning was on.
    await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "null-1", ...auth });
    await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "null-2", ...auth });

    const archived = h.ctx.repos.objectVersions.find(bucketId(h), "a.txt", v1)!;
    expect(h.storage.contentOf(archived.drive_file_id!)).toBeTruthy();
    expect(await (await h.signAndSend({
      method: "GET", path: "/docs/a.txt", query: { versionId: v1 }, ...auth,
    })).text()).toBe("keep");
    expect(await (await h.signAndSend({ method: "GET", path: "/docs/a.txt", ...auth })).text())
      .toBe("null-2");
  });

  test("a suspended delete keeps retained versions and hides the key", async () => {
    const { h, auth } = await setup();
    const first = await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "keep", ...auth });
    const v1 = first.headers.get("x-amz-version-id")!;

    await h.signAndSend({
      method: "PUT", path: "/docs", query: { versioning: "" }, body: SUSPEND, ...auth,
    });
    const del = await h.signAndSend({ method: "DELETE", path: "/docs/a.txt", ...auth });
    expect(del.status).toBe(204);
    expect(del.headers.get("x-amz-delete-marker")).toBe("true");

    expect((await h.signAndSend({ method: "GET", path: "/docs/a.txt", ...auth })).status).toBe(404);
    expect(await (await h.signAndSend({
      method: "GET", path: "/docs/a.txt", query: { versionId: v1 }, ...auth,
    })).text()).toBe("keep");
  });

  test("repeated suspended write-then-delete cycles do not collide", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({
      method: "PUT", path: "/docs", query: { versioning: "" }, body: SUSPEND, ...auth,
    });
    // Each cycle writes and removes a 'null' version; the version id repeats,
    // so anything that inserted blindly would hit the unique constraint.
    for (let i = 0; i < 3; i++) {
      const put = await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: `n${i}`, ...auth });
      expect(put.status).toBe(200);
      const del = await h.signAndSend({ method: "DELETE", path: "/docs/a.txt", ...auth });
      expect(del.status).toBe(204);
    }
    expect((await h.signAndSend({ method: "GET", path: "/docs/a.txt", ...auth })).status).toBe(404);
  });

  test("an unknown version id is a 404", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v1", ...auth });
    const res = await h.signAndSend({
      method: "GET", path: "/docs/a.txt", query: { versionId: "v-nope" }, ...auth,
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("NoSuchVersion");
  });
});

describe("delete markers", () => {
  test("delete hides the key but keeps the data", async () => {
    const { h, auth } = await setup();
    const put = await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v1", ...auth });
    const v1 = put.headers.get("x-amz-version-id")!;

    const del = await h.signAndSend({ method: "DELETE", path: "/docs/a.txt", ...auth });
    expect(del.status).toBe(204);
    expect(del.headers.get("x-amz-delete-marker")).toBe("true");
    const markerId = del.headers.get("x-amz-version-id")!;
    expect(markerId).toBeTruthy();

    // The key is gone...
    const get = await h.signAndSend({ method: "GET", path: "/docs/a.txt", ...auth });
    expect(get.status).toBe(404);
    expect(await get.text()).toContain("<DeleteMarker>true</DeleteMarker>");

    // ...but the version is still there.
    expect(await (await h.signAndSend({
      method: "GET", path: "/docs/a.txt", query: { versionId: v1 }, ...auth,
    })).text()).toBe("v1");
  });

  test("deleting the marker restores the key", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v1", ...auth });
    const del = await h.signAndSend({ method: "DELETE", path: "/docs/a.txt", ...auth });
    const markerId = del.headers.get("x-amz-version-id")!;

    expect((await h.signAndSend({ method: "GET", path: "/docs/a.txt", ...auth })).status).toBe(404);

    const undelete = await h.signAndSend({
      method: "DELETE", path: "/docs/a.txt", query: { versionId: markerId }, ...auth,
    });
    expect(undelete.status).toBe(204);
    expect(undelete.headers.get("x-amz-delete-marker")).toBe("true");

    const restored = await h.signAndSend({ method: "GET", path: "/docs/a.txt", ...auth });
    expect(restored.status).toBe(200);
    expect(await restored.text()).toBe("v1");
  });

  test("a delete marker restores the newest version, not an older one", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v1", ...auth });
    await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v2", ...auth });
    const del = await h.signAndSend({ method: "DELETE", path: "/docs/a.txt", ...auth });
    const markerId = del.headers.get("x-amz-version-id")!;

    await h.signAndSend({
      method: "DELETE", path: "/docs/a.txt", query: { versionId: markerId }, ...auth,
    });
    expect(await (await h.signAndSend({ method: "GET", path: "/docs/a.txt", ...auth })).text())
      .toBe("v2");
  });

  test("GET on a delete marker by id is a 405, not a 404", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v1", ...auth });
    const del = await h.signAndSend({ method: "DELETE", path: "/docs/a.txt", ...auth });
    const markerId = del.headers.get("x-amz-version-id")!;

    const res = await h.signAndSend({
      method: "GET", path: "/docs/a.txt", query: { versionId: markerId }, ...auth,
    });
    expect(res.status).toBe(405);
  });

  test("HEAD on a hidden key reports the delete marker", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v1", ...auth });
    await h.signAndSend({ method: "DELETE", path: "/docs/a.txt", ...auth });
    const head = await h.signAndSend({ method: "HEAD", path: "/docs/a.txt", ...auth });
    expect(head.status).toBe(404);
  });

  test("a hidden key is absent from an ordinary listing", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v1", ...auth });
    await h.signAndSend({ method: "PUT", path: "/docs/b.txt", body: "b", ...auth });
    await h.signAndSend({ method: "DELETE", path: "/docs/a.txt", ...auth });

    const list = await h.signAndSend({
      method: "GET", path: "/docs", query: { "list-type": "2" }, ...auth,
    });
    const xml = await list.text();
    expect(xml).not.toContain("<Key>a.txt</Key>");
    expect(xml).toContain("<Key>b.txt</Key>");
  });
});

describe("deleting a specific version", () => {
  test("removes only that version", async () => {
    const { h, auth } = await setup();
    const first = await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v1", ...auth });
    const v1 = first.headers.get("x-amz-version-id")!;
    await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v2", ...auth });

    const del = await h.signAndSend({
      method: "DELETE", path: "/docs/a.txt", query: { versionId: v1 }, ...auth,
    });
    expect(del.status).toBe(204);

    expect((await h.signAndSend({
      method: "GET", path: "/docs/a.txt", query: { versionId: v1 }, ...auth,
    })).status).toBe(404);
    // The current version is untouched.
    expect(await (await h.signAndSend({ method: "GET", path: "/docs/a.txt", ...auth })).text())
      .toBe("v2");
  });

  test("deleting the current version promotes the previous one", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v1", ...auth });
    const second = await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v2", ...auth });
    const v2 = second.headers.get("x-amz-version-id")!;

    await h.signAndSend({
      method: "DELETE", path: "/docs/a.txt", query: { versionId: v2 }, ...auth,
    });

    // The key must not be left with versions but no current row.
    const get = await h.signAndSend({ method: "GET", path: "/docs/a.txt", ...auth });
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("v1");
  });
});

describe("ListObjectVersions", () => {
  test("reports every version and marker with the latest flagged", async () => {
    const { h, auth } = await setup();
    const first = await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v1", ...auth });
    const v1 = first.headers.get("x-amz-version-id")!;
    const second = await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v2", ...auth });
    const v2 = second.headers.get("x-amz-version-id")!;

    const res = await h.signAndSend({
      method: "GET", path: "/docs", query: { versions: "" }, ...auth,
    });
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain(`<VersionId>${v1}</VersionId>`);
    expect(xml).toContain(`<VersionId>${v2}</VersionId>`);
    // The current version is the latest; the archived one is not.
    const v2Block = xml.slice(xml.indexOf(v2) - 200, xml.indexOf(v2) + 200);
    expect(v2Block).toContain("<IsLatest>true</IsLatest>");
  });

  test("includes delete markers as their own element", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v1", ...auth });
    await h.signAndSend({ method: "DELETE", path: "/docs/a.txt", ...auth });

    const xml = await (await h.signAndSend({
      method: "GET", path: "/docs", query: { versions: "" }, ...auth,
    })).text();
    expect(xml).toContain("<DeleteMarker>");
    expect(xml).toContain("<Version>");
  });

  test("honours prefix and delimiter", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({ method: "PUT", path: "/docs/reports/q1.txt", body: "a", ...auth });
    await h.signAndSend({ method: "PUT", path: "/docs/reports/q2.txt", body: "b", ...auth });
    await h.signAndSend({ method: "PUT", path: "/docs/top.txt", body: "c", ...auth });

    const scoped = await (await h.signAndSend({
      method: "GET", path: "/docs", query: { versions: "", prefix: "reports/" }, ...auth,
    })).text();
    expect(scoped).toContain("q1.txt");
    expect(scoped).not.toContain("top.txt");

    const rolled = await (await h.signAndSend({
      method: "GET", path: "/docs", query: { versions: "", delimiter: "/" }, ...auth,
    })).text();
    expect(rolled).toContain("<Prefix>reports/</Prefix>");
  });

  test("paginates with key and version markers", async () => {
    const { h, auth } = await setup();
    for (const key of ["a.txt", "b.txt", "c.txt"]) {
      await h.signAndSend({ method: "PUT", path: `/docs/${key}`, body: key, ...auth });
    }

    const firstPage = await (await h.signAndSend({
      method: "GET", path: "/docs", query: { versions: "", "max-keys": "2" }, ...auth,
    })).text();
    expect(firstPage).toContain("<IsTruncated>true</IsTruncated>");
    const nextKey = /<NextKeyMarker>([^<]+)<\/NextKeyMarker>/.exec(firstPage)![1]!;

    const secondPage = await (await h.signAndSend({
      method: "GET",
      path: "/docs",
      query: { versions: "", "max-keys": "2", "key-marker": nextKey },
      ...auth,
    })).text();
    expect(secondPage).toContain("c.txt");
    expect(secondPage).not.toContain("<Key>a.txt</Key>");
  });
});

describe("versioning and encryption together", () => {
  test("an encrypted version stays readable after being superseded", async () => {
    const { h, auth } = await setup();
    const first = await h.signAndSend({
      method: "PUT",
      path: "/docs/secret.txt",
      headers: { "x-amz-server-side-encryption": "AES256" },
      body: "encrypted v1",
      ...auth,
    });
    const v1 = first.headers.get("x-amz-version-id")!;
    expect(first.headers.get("x-amz-server-side-encryption")).toBe("AES256");

    await h.signAndSend({
      method: "PUT", path: "/docs/secret.txt",
      headers: { "x-amz-server-side-encryption": "AES256" },
      body: "encrypted v2", ...auth,
    });

    // The archived version carries its own key material, so it must still
    // decrypt even though object_encryption now describes the newer object.
    const old = await h.signAndSend({
      method: "GET", path: "/docs/secret.txt", query: { versionId: v1 }, ...auth,
    });
    expect(old.status).toBe(200);
    expect(await old.text()).toBe("encrypted v1");
    expect(old.headers.get("x-amz-server-side-encryption")).toBe("AES256");
  });

  test("restoring an encrypted version through a delete marker still decrypts", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({
      method: "PUT", path: "/docs/secret.txt",
      headers: { "x-amz-server-side-encryption": "AES256" },
      body: "encrypted original", ...auth,
    });
    const del = await h.signAndSend({ method: "DELETE", path: "/docs/secret.txt", ...auth });
    const markerId = del.headers.get("x-amz-version-id")!;

    await h.signAndSend({
      method: "DELETE", path: "/docs/secret.txt", query: { versionId: markerId }, ...auth,
    });

    const restored = await h.signAndSend({ method: "GET", path: "/docs/secret.txt", ...auth });
    expect(restored.status).toBe(200);
    expect(await restored.text()).toBe("encrypted original");
    expect(restored.headers.get("x-amz-server-side-encryption")).toBe("AES256");
  });
});
