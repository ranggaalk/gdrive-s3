import { describe, expect, test } from "bun:test";
import { makeHarness } from "./_helpers.ts";

function between(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((match) => match[1]!);
}

async function setup(email: string, keys: string[]) {
  const harness = makeHarness();
  const user = harness.seedUser(email);
  const credential = harness.seedCredential(user.id);
  const auth = {
    accessKeyId: credential.accessKeyId,
    secretAccessKey: credential.secretAccessKey,
  };
  expect((await harness.signAndSend({ method: "PUT", path: "/docs", ...auth })).status).toBe(200);
  for (const key of keys) {
    const response = await harness.signAndSend({
      method: "PUT",
      path: `/docs/${encodeURIComponent(key).replaceAll("%2F", "/")}`,
      body: key,
      ...auth,
    });
    expect(response.status).toBe(200);
  }
  return { harness, auth };
}

describe("ListObjects v1 integration", () => {
  test("bare bucket GET lists objects with v1 fields", async () => {
    const { harness, auth } = await setup("list-v1@x.com", ["a.txt", "z.txt"]);
    const response = await harness.signAndSend({ method: "GET", path: "/docs", ...auth });
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(between(xml, "Key")).toEqual(["a.txt", "z.txt"]);
    expect(xml).toContain("<Marker></Marker>");
    expect(xml).toContain("<MaxKeys>1000</MaxKeys>");
    expect(xml).toContain("<IsTruncated>false</IsTruncated>");
    expect(xml).toContain("<StorageClass>STANDARD</StorageClass>");
    expect(xml).not.toContain("<KeyCount>");
    expect(xml).not.toContain("ContinuationToken");
  });

  test("prefix and delimiter return contents and common prefixes", async () => {
    const { harness, auth } = await setup("list-v1-delimiter@x.com", [
      "a.txt",
      "dir/one.txt",
      "dir/two.txt",
      "dir/sub/deep.txt",
      "z.txt",
    ]);
    const response = await harness.signAndSend({
      method: "GET",
      path: "/docs",
      query: { delimiter: "/", prefix: "" },
      ...auth,
    });
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(between(xml, "Key")).toEqual(["a.txt", "z.txt"]);
    expect(between(xml, "Prefix")).toContain("dir/");
    expect(xml).toContain("<Delimiter>/</Delimiter>");
  });

  test("marker resumes after an object key", async () => {
    const { harness, auth } = await setup("list-v1-page@x.com", ["a", "b", "c"]);
    let response = await harness.signAndSend({
      method: "GET",
      path: "/docs",
      query: { "max-keys": "2" },
      ...auth,
    });
    let xml = await response.text();
    expect(between(xml, "Key")).toEqual(["a", "b"]);
    expect(xml).toContain("<IsTruncated>true</IsTruncated>");
    expect(between(xml, "NextMarker")).toEqual(["b"]);

    response = await harness.signAndSend({
      method: "GET",
      path: "/docs",
      query: { marker: "b", "max-keys": "2" },
      ...auth,
    });
    xml = await response.text();
    expect(between(xml, "Key")).toEqual(["c"]);
    expect(xml).toContain("<IsTruncated>false</IsTruncated>");
  });

  test("NextMarker resumes after a common-prefix-only page", async () => {
    const { harness, auth } = await setup("list-v1-prefix-page@x.com", [
      "a/one",
      "a/two",
      "b/one",
      "c/one",
    ]);
    let response = await harness.signAndSend({
      method: "GET",
      path: "/docs",
      query: { delimiter: "/", "max-keys": "1" },
      ...auth,
    });
    let xml = await response.text();
    expect(between(xml, "Prefix")).toContain("a/");
    expect(between(xml, "NextMarker")).toEqual(["a/"]);
    expect(xml).toContain("<IsTruncated>true</IsTruncated>");

    response = await harness.signAndSend({
      method: "GET",
      path: "/docs",
      query: { delimiter: "/", marker: "a/", "max-keys": "1" },
      ...auth,
    });
    xml = await response.text();
    expect(between(xml, "Prefix")).not.toContain("a/");
    expect(between(xml, "Prefix")).toContain("b/");
  });

  test("URL encoding and query validation follow the S3 contract", async () => {
    const { harness, auth } = await setup("list-v1-encoding@x.com", ["dir/file (1).txt"]);
    let response = await harness.signAndSend({
      method: "GET",
      path: "/docs",
      query: { "encoding-type": "url" },
      ...auth,
    });
    let xml = await response.text();
    expect(response.status).toBe(200);
    expect(xml).toContain("<Key>dir%2Ffile%20%281%29.txt</Key>");
    expect(xml).toContain("<EncodingType>url</EncodingType>");

    const invalidQueries: Array<Record<string, string>> = [
      { "max-keys": "-1" },
      { "max-keys": "1.5" },
      { "encoding-type": "base64" },
      { "list-type": "1" },
    ];
    for (const query of invalidQueries) {
      response = await harness.signAndSend({ method: "GET", path: "/docs", query, ...auth });
      xml = await response.text();
      expect(response.status).toBe(400);
      expect(xml).toContain("<Code>InvalidArgument</Code>");
    }
  });
});
