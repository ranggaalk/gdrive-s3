import { describe, expect, test } from "bun:test";
import { makeHarness } from "./_helpers.ts";

function between(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1]!);
}

describe("ListObjectsV2 integration", () => {
  test("prefix + delimiter returns Contents and CommonPrefixes", async () => {
    const h = makeHarness();
    const u = h.seedUser("list@x.com");
    const c = h.seedCredential(u.id);
    const auth = { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey };
    await h.signAndSend({ method: "PUT", path: "/docs", ...auth });
    for (const key of ["a.txt", "dir/one.txt", "dir/two.txt", "dir/sub/deep.txt", "z.txt"]) {
      const res = await h.signAndSend({
        method: "PUT",
        path: `/docs/${key}`,
        body: key,
        ...auth,
      });
      expect(res.status).toBe(200);
    }

    const res = await h.signAndSend({
      method: "GET",
      path: "/docs",
      query: { "list-type": "2", delimiter: "/" },
      ...auth,
    });
    const xml = await res.text();
    expect(res.status).toBe(200);
    expect(between(xml, "Key")).toEqual(["a.txt", "z.txt"]);
    expect(between(xml, "Prefix")).toContain("dir/");
    expect(xml).toContain("<KeyCount>3</KeyCount>");
  });

  test("max-keys produces signed continuation token and next page", async () => {
    const h = makeHarness();
    const u = h.seedUser("page@x.com");
    const c = h.seedCredential(u.id);
    const auth = { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey };
    await h.signAndSend({ method: "PUT", path: "/docs", ...auth });
    for (const key of ["a", "b", "c"]) {
      await h.signAndSend({ method: "PUT", path: `/docs/${key}`, body: key, ...auth });
    }

    let res = await h.signAndSend({
      method: "GET",
      path: "/docs",
      query: { "list-type": "2", "max-keys": "2" },
      ...auth,
    });
    let xml = await res.text();
    expect(xml).toContain("<IsTruncated>true</IsTruncated>");
    expect(between(xml, "Key")).toEqual(["a", "b"]);
    const token = between(xml, "NextContinuationToken")[0]!;
    expect(token).toContain(".");

    res = await h.signAndSend({
      method: "GET",
      path: "/docs",
      query: { "list-type": "2", "continuation-token": token },
      ...auth,
    });
    xml = await res.text();
    expect(between(xml, "Key")).toEqual(["c"]);
    expect(xml).toContain("<IsTruncated>false</IsTruncated>");
  });

  test("tampered continuation token is rejected on an accessible bucket", async () => {
    const h = makeHarness();
    const u = h.seedUser("tamper@x.com");
    const c = h.seedCredential(u.id);
    const auth = { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey };
    await h.signAndSend({ method: "PUT", path: "/docs", ...auth });
    const res = await h.signAndSend({
      method: "GET",
      path: "/docs",
      query: { "list-type": "2", "continuation-token": "bogus.token" },
      ...auth,
    });
    const xml = await res.text();
    expect(res.status).toBe(400);
    expect(xml).toContain("<Code>InvalidArgument</Code>");
    expect(xml).toContain("<ArgumentName>continuation-token</ArgumentName>");
  });

  test("continuation token is bound to prefix and delimiter", async () => {
    const h = makeHarness();
    const u = h.seedUser("bound@x.com");
    const c = h.seedCredential(u.id);
    const auth = { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey };
    await h.signAndSend({ method: "PUT", path: "/docs", ...auth });
    for (const key of ["dir/a", "dir/b"]) {
      await h.signAndSend({ method: "PUT", path: `/docs/${key}`, body: key, ...auth });
    }
    let res = await h.signAndSend({
      method: "GET",
      path: "/docs",
      query: { "list-type": "2", prefix: "dir/", "max-keys": "1" },
      ...auth,
    });
    let xml = await res.text();
    const token = between(xml, "NextContinuationToken")[0]!;

    res = await h.signAndSend({
      method: "GET",
      path: "/docs",
      query: { "list-type": "2", prefix: "", "continuation-token": token },
      ...auth,
    });
    xml = await res.text();
    expect(res.status).toBe(400);
    expect(xml).toContain("<ArgumentName>continuation-token</ArgumentName>");
  });

  test("start-after does not repeat a delimiter common prefix", async () => {
    const h = makeHarness();
    const u = h.seedUser("start-after@x.com");
    const c = h.seedCredential(u.id);
    const auth = { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey };
    await h.signAndSend({ method: "PUT", path: "/docs", ...auth });
    for (const key of ["dir/a", "dir/b", "z"]) {
      await h.signAndSend({ method: "PUT", path: `/docs/${key}`, body: key, ...auth });
    }
    const res = await h.signAndSend({
      method: "GET",
      path: "/docs",
      query: { "list-type": "2", delimiter: "/", "start-after": "dir/" },
      ...auth,
    });
    const xml = await res.text();
    expect(res.status).toBe(200);
    expect(between(xml, "Prefix")).not.toContain("dir/");
    expect(between(xml, "Key")).toEqual(["z"]);
  });
});
