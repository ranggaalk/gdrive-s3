import { describe, expect, test } from "bun:test";
import { makeHarness } from "./_helpers.ts";

/** Two users, each with their own bucket, in one gateway. */
async function twoUsers() {
  const h = makeHarness();
  const alice = h.seedUser("alice@x.com");
  const bob = h.seedUser("bob@x.com");
  const aliceCred = h.seedCredential(alice.id);
  const bobCred = h.seedCredential(bob.id);
  const aliceAuth = {
    accessKeyId: aliceCred.accessKeyId,
    secretAccessKey: aliceCred.secretAccessKey,
  };
  const bobAuth = { accessKeyId: bobCred.accessKeyId, secretAccessKey: bobCred.secretAccessKey };

  await h.signAndSend({ method: "PUT", path: "/alice-src", ...aliceAuth });
  await h.signAndSend({ method: "PUT", path: "/bob-dst", ...bobAuth });
  return { h, alice, bob, aliceAuth, bobAuth };
}

/** Let Bob read Alice's bucket through a policy naming him. */
async function grantBobRead(
  h: ReturnType<typeof makeHarness>,
  aliceAuth: { accessKeyId: string; secretAccessKey: string },
) {
  await h.signAndSend({
    method: "PUT",
    path: "/alice-src",
    query: { policy: "" },
    body: JSON.stringify({
      Statement: [{
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam:::user/bob@x.com" },
        Action: "s3:GetObject",
        Resource: "arn:aws:s3:::alice-src/*",
      }],
    }),
    ...aliceAuth,
  });
}

function sample(length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = (i * 41 + 13) % 256;
  return out;
}

describe("cross-user CopyObject", () => {
  test("is refused without a grant", async () => {
    const { h, aliceAuth, bobAuth } = await twoUsers();
    await h.signAndSend({ method: "PUT", path: "/alice-src/doc.txt", body: "alice data", ...aliceAuth });

    const res = await h.signAndSend({
      method: "PUT",
      path: "/bob-dst/copied.txt",
      headers: { "x-amz-copy-source": "/alice-src/doc.txt" },
      ...bobAuth,
    });
    expect(res.status).toBe(404);
  });

  test("succeeds once a policy grants the read", async () => {
    const { h, aliceAuth, bobAuth } = await twoUsers();
    await h.signAndSend({ method: "PUT", path: "/alice-src/doc.txt", body: "alice data", ...aliceAuth });
    await grantBobRead(h, aliceAuth);

    const res = await h.signAndSend({
      method: "PUT",
      path: "/bob-dst/copied.txt",
      headers: { "x-amz-copy-source": "/alice-src/doc.txt" },
      ...bobAuth,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<CopyObjectResult");

    // Bob really owns the copy, and Alice's original is untouched.
    const bobCopy = await h.signAndSend({ method: "GET", path: "/bob-dst/copied.txt", ...bobAuth });
    expect(await bobCopy.text()).toBe("alice data");
    const original = await h.signAndSend({ method: "GET", path: "/alice-src/doc.txt", ...aliceAuth });
    expect(await original.text()).toBe("alice data");
  });

  test("the copy lands in the target owner's Drive, not the source owner's", async () => {
    const { h, aliceAuth, bobAuth } = await twoUsers();
    await h.signAndSend({ method: "PUT", path: "/alice-src/doc.txt", body: "alice data", ...aliceAuth });
    await grantBobRead(h, aliceAuth);
    await h.signAndSend({
      method: "PUT",
      path: "/bob-dst/copied.txt",
      headers: { "x-amz-copy-source": "/alice-src/doc.txt" },
      ...bobAuth,
    });

    const aliceBucket = h.ctx.repos.buckets.listByName("alice-src")[0]!;
    const bobBucket = h.ctx.repos.buckets.listByName("bob-dst")[0]!;
    const original = h.ctx.repos.objects.findByKey(aliceBucket.id, "doc.txt")!;
    const copy = h.ctx.repos.objects.findByKey(bobBucket.id, "copied.txt")!;

    // Distinct Drive files: the copy is a new object, not a shared reference.
    expect(copy.drive_file_id).not.toBe(original.drive_file_id);
    expect(h.storage.contentOf(copy.drive_file_id)).toBeTruthy();
  });

  test("a read-only grant does not permit copying into the source bucket", async () => {
    const { h, aliceAuth, bobAuth } = await twoUsers();
    await h.signAndSend({ method: "PUT", path: "/bob-dst/mine.txt", body: "bob data", ...bobAuth });
    await grantBobRead(h, aliceAuth);

    // Bob may read Alice's bucket but not write to it.
    const res = await h.signAndSend({
      method: "PUT",
      path: "/alice-src/intruder.txt",
      headers: { "x-amz-copy-source": "/bob-dst/mine.txt" },
      ...bobAuth,
    });
    expect(res.status).toBe(403);
  });

  test("copying an encrypted source into a plain bucket decrypts it", async () => {
    const { h, aliceAuth, bobAuth } = await twoUsers();
    await h.signAndSend({
      method: "PUT",
      path: "/alice-src/secret.txt",
      headers: { "x-amz-server-side-encryption": "AES256" },
      body: "encrypted source",
      ...aliceAuth,
    });
    await grantBobRead(h, aliceAuth);

    const res = await h.signAndSend({
      method: "PUT",
      path: "/bob-dst/plain.txt",
      headers: { "x-amz-copy-source": "/alice-src/secret.txt" },
      ...bobAuth,
    });
    expect(res.status).toBe(200);
    // The target bucket has no encryption configured, so the copy is stored
    // in the clear — and must still read back correctly.
    expect(res.headers.has("x-amz-server-side-encryption")).toBe(false);
    expect(await (await h.signAndSend({ method: "GET", path: "/bob-dst/plain.txt", ...bobAuth })).text())
      .toBe("encrypted source");

    const bobBucket = h.ctx.repos.buckets.listByName("bob-dst")[0]!;
    const copy = h.ctx.repos.objects.findByKey(bobBucket.id, "plain.txt")!;
    expect(Buffer.from(h.storage.contentOf(copy.drive_file_id)).toString("utf8"))
      .toBe("encrypted source");
  });

  test("copying into an encrypted bucket encrypts the target", async () => {
    const { h, aliceAuth, bobAuth } = await twoUsers();
    await h.signAndSend({ method: "PUT", path: "/alice-src/doc.txt", body: "plain source", ...aliceAuth });
    await grantBobRead(h, aliceAuth);

    const res = await h.signAndSend({
      method: "PUT",
      path: "/bob-dst/enc.txt",
      headers: {
        "x-amz-copy-source": "/alice-src/doc.txt",
        "x-amz-server-side-encryption": "AES256",
      },
      ...bobAuth,
    });
    expect(res.headers.get("x-amz-server-side-encryption")).toBe("AES256");

    const bobBucket = h.ctx.repos.buckets.listByName("bob-dst")[0]!;
    const copy = h.ctx.repos.objects.findByKey(bobBucket.id, "enc.txt")!;
    expect(Buffer.from(h.storage.contentOf(copy.drive_file_id)).toString("utf8"))
      .not.toBe("plain source");
    expect(await (await h.signAndSend({ method: "GET", path: "/bob-dst/enc.txt", ...bobAuth })).text())
      .toBe("plain source");
  });
});

describe("copy source preconditions", () => {
  async function setup() {
    const h = makeHarness();
    const user = h.seedUser("owner@x.com");
    const cred = h.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
    await h.signAndSend({ method: "PUT", path: "/docs", ...auth });
    const put = await h.signAndSend({ method: "PUT", path: "/docs/src.txt", body: "source", ...auth });
    return { h, auth, etag: put.headers.get("etag")! };
  }

  test("if-match succeeds on the right etag and fails on the wrong one", async () => {
    const { h, auth, etag } = await setup();

    const ok = await h.signAndSend({
      method: "PUT",
      path: "/docs/copy1.txt",
      headers: { "x-amz-copy-source": "/docs/src.txt", "x-amz-copy-source-if-match": etag },
      ...auth,
    });
    expect(ok.status).toBe(200);

    const bad = await h.signAndSend({
      method: "PUT",
      path: "/docs/copy2.txt",
      headers: {
        "x-amz-copy-source": "/docs/src.txt",
        "x-amz-copy-source-if-match": '"00000000000000000000000000000000"',
      },
      ...auth,
    });
    expect(bad.status).toBe(412);
  });

  test("if-none-match fails when the etag matches", async () => {
    const { h, auth, etag } = await setup();
    const res = await h.signAndSend({
      method: "PUT",
      path: "/docs/copy.txt",
      headers: { "x-amz-copy-source": "/docs/src.txt", "x-amz-copy-source-if-none-match": etag },
      ...auth,
    });
    expect(res.status).toBe(412);
  });

  test("if-unmodified-since fails for a source modified after the date", async () => {
    const { h, auth } = await setup();
    const res = await h.signAndSend({
      method: "PUT",
      path: "/docs/copy.txt",
      headers: {
        "x-amz-copy-source": "/docs/src.txt",
        "x-amz-copy-source-if-unmodified-since": new Date(Date.now() - 3600_000).toUTCString(),
      },
      ...auth,
    });
    expect(res.status).toBe(412);
  });

  test("if-modified-since fails for a source older than the date", async () => {
    const { h, auth } = await setup();
    const res = await h.signAndSend({
      method: "PUT",
      path: "/docs/copy.txt",
      headers: {
        "x-amz-copy-source": "/docs/src.txt",
        "x-amz-copy-source-if-modified-since": new Date(Date.now() + 3600_000).toUTCString(),
      },
      ...auth,
    });
    expect(res.status).toBe(412);
  });

  test("CopyObject refuses a range header rather than ignoring it", async () => {
    const { h, auth } = await setup();
    const res = await h.signAndSend({
      method: "PUT",
      path: "/docs/copy.txt",
      headers: {
        "x-amz-copy-source": "/docs/src.txt",
        "x-amz-copy-source-range": "bytes=0-2",
      },
      ...auth,
    });
    expect(res.status).toBe(400);
  });
});

describe("copying a specific version", () => {
  test("copies the named version, not the current one", async () => {
    const h = makeHarness();
    const user = h.seedUser("owner@x.com");
    const cred = h.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
    await h.signAndSend({ method: "PUT", path: "/docs", ...auth });
    await h.signAndSend({
      method: "PUT", path: "/docs", query: { versioning: "" },
      body: "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>",
      ...auth,
    });

    const first = await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v1", ...auth });
    const v1 = first.headers.get("x-amz-version-id")!;
    await h.signAndSend({ method: "PUT", path: "/docs/a.txt", body: "v2", ...auth });

    const res = await h.signAndSend({
      method: "PUT",
      path: "/docs/old-copy.txt",
      headers: { "x-amz-copy-source": `/docs/a.txt?versionId=${v1}` },
      ...auth,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-amz-copy-source-version-id")).toBe(v1);
    expect(await (await h.signAndSend({ method: "GET", path: "/docs/old-copy.txt", ...auth })).text())
      .toBe("v1");
  });
});

describe("UploadPartCopy", () => {
  async function setupLarge() {
    const h = makeHarness();
    const user = h.seedUser("owner@x.com");
    const cred = h.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
    await h.signAndSend({ method: "PUT", path: "/docs", ...auth });
    // Two 5 MiB halves, so each copied part clears the multipart minimum.
    const body = sample(10 * 1024 * 1024);
    await h.signAndSend({
      method: "PUT", path: "/docs/big.bin", body: new Uint8Array(body), ...auth,
    });
    return { h, auth, body };
  }

  test("assembles an object from ranges of another one", async () => {
    const { h, auth, body } = await setupLarge();

    const create = await h.signAndSend({
      method: "POST", path: "/docs/assembled.bin", query: { uploads: "" }, ...auth,
    });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await create.text())![1]!;

    const half = body.length / 2;
    const etags: string[] = [];
    const ranges = [`bytes=0-${half - 1}`, `bytes=${half}-${body.length - 1}`];
    for (const [index, range] of ranges.entries()) {
      const res = await h.signAndSend({
        method: "PUT",
        path: "/docs/assembled.bin",
        query: { uploadId, partNumber: String(index + 1) },
        headers: {
          "x-amz-copy-source": "/docs/big.bin",
          "x-amz-copy-source-range": range,
        },
        ...auth,
      });
      expect(res.status).toBe(200);
      const xml = await res.text();
      expect(xml).toContain("<CopyPartResult");
      etags.push(/<ETag>([^<]+)<\/ETag>/.exec(xml)![1]!);
    }

    const complete = await h.signAndSend({
      method: "POST",
      path: "/docs/assembled.bin",
      query: { uploadId },
      body:
        "<CompleteMultipartUpload>" +
        etags.map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`).join("") +
        "</CompleteMultipartUpload>",
      ...auth,
    });
    expect(complete.status).toBe(200);

    const read = await h.signAndSend({ method: "GET", path: "/docs/assembled.bin", ...auth });
    expect(Buffer.from(await read.arrayBuffer()).equals(body)).toBe(true);
  });

  test("copies a whole object when no range is given", async () => {
    const { h, auth, body } = await setupLarge();
    const create = await h.signAndSend({
      method: "POST", path: "/docs/whole.bin", query: { uploads: "" }, ...auth,
    });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await create.text())![1]!;

    const part = await h.signAndSend({
      method: "PUT",
      path: "/docs/whole.bin",
      query: { uploadId, partNumber: "1" },
      headers: { "x-amz-copy-source": "/docs/big.bin" },
      ...auth,
    });
    expect(part.status).toBe(200);
    const etag = /<ETag>([^<]+)<\/ETag>/.exec(await part.text())![1]!;

    await h.signAndSend({
      method: "POST",
      path: "/docs/whole.bin",
      query: { uploadId },
      body: `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${etag}</ETag></Part></CompleteMultipartUpload>`,
      ...auth,
    });
    const read = await h.signAndSend({ method: "GET", path: "/docs/whole.bin", ...auth });
    expect(Buffer.from(await read.arrayBuffer()).equals(body)).toBe(true);
  });

  test("rejects an unsatisfiable range", async () => {
    const { h, auth } = await setupLarge();
    const create = await h.signAndSend({
      method: "POST", path: "/docs/x.bin", query: { uploads: "" }, ...auth,
    });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await create.text())![1]!;

    const res = await h.signAndSend({
      method: "PUT",
      path: "/docs/x.bin",
      query: { uploadId, partNumber: "1" },
      headers: {
        "x-amz-copy-source": "/docs/big.bin",
        "x-amz-copy-source-range": "bytes=99999999-99999999",
      },
      ...auth,
    });
    expect(res.status).toBe(416);
  });

  test("ranges an encrypted source correctly", async () => {
    const h = makeHarness();
    const user = h.seedUser("owner@x.com");
    const cred = h.seedCredential(user.id);
    const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
    await h.signAndSend({ method: "PUT", path: "/docs", ...auth });
    const body = sample(6 * 1024 * 1024);
    await h.signAndSend({
      method: "PUT",
      path: "/docs/enc.bin",
      headers: { "x-amz-server-side-encryption": "AES256" },
      body: new Uint8Array(body),
      ...auth,
    });

    const create = await h.signAndSend({
      method: "POST", path: "/docs/tail.bin", query: { uploads: "" }, ...auth,
    });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await create.text())![1]!;

    // A start offset that is not a multiple of the 16-byte AES block, which is
    // the case a naive CTR seek gets wrong.
    const start = 1_000_001;
    const part = await h.signAndSend({
      method: "PUT",
      path: "/docs/tail.bin",
      query: { uploadId, partNumber: "1" },
      headers: {
        "x-amz-copy-source": "/docs/enc.bin",
        "x-amz-copy-source-range": `bytes=${start}-${body.length - 1}`,
      },
      ...auth,
    });
    expect(part.status).toBe(200);
    const etag = /<ETag>([^<]+)<\/ETag>/.exec(await part.text())![1]!;

    await h.signAndSend({
      method: "POST",
      path: "/docs/tail.bin",
      query: { uploadId },
      body: `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${etag}</ETag></Part></CompleteMultipartUpload>`,
      ...auth,
    });
    const read = await h.signAndSend({ method: "GET", path: "/docs/tail.bin", ...auth });
    expect(Buffer.from(await read.arrayBuffer()).equals(body.subarray(start))).toBe(true);
  });

  test("copies across users when a policy allows it", async () => {
    const { h, aliceAuth, bobAuth } = await twoUsers();
    const body = sample(6 * 1024 * 1024);
    await h.signAndSend({
      method: "PUT", path: "/alice-src/big.bin", body: new Uint8Array(body), ...aliceAuth,
    });
    await grantBobRead(h, aliceAuth);

    const create = await h.signAndSend({
      method: "POST", path: "/bob-dst/from-alice.bin", query: { uploads: "" }, ...bobAuth,
    });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await create.text())![1]!;

    const part = await h.signAndSend({
      method: "PUT",
      path: "/bob-dst/from-alice.bin",
      query: { uploadId, partNumber: "1" },
      headers: { "x-amz-copy-source": "/alice-src/big.bin" },
      ...bobAuth,
    });
    expect(part.status).toBe(200);
    const etag = /<ETag>([^<]+)<\/ETag>/.exec(await part.text())![1]!;

    await h.signAndSend({
      method: "POST",
      path: "/bob-dst/from-alice.bin",
      query: { uploadId },
      body: `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${etag}</ETag></Part></CompleteMultipartUpload>`,
      ...bobAuth,
    });
    const read = await h.signAndSend({ method: "GET", path: "/bob-dst/from-alice.bin", ...bobAuth });
    expect(Buffer.from(await read.arrayBuffer()).equals(body)).toBe(true);
  });

  test("is refused without a grant on the source", async () => {
    const { h, aliceAuth, bobAuth } = await twoUsers();
    await h.signAndSend({ method: "PUT", path: "/alice-src/big.bin", body: "private", ...aliceAuth });

    const create = await h.signAndSend({
      method: "POST", path: "/bob-dst/steal.bin", query: { uploads: "" }, ...bobAuth,
    });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await create.text())![1]!;

    const res = await h.signAndSend({
      method: "PUT",
      path: "/bob-dst/steal.bin",
      query: { uploadId, partNumber: "1" },
      headers: { "x-amz-copy-source": "/alice-src/big.bin" },
      ...bobAuth,
    });
    expect(res.status).toBe(404);
  });

  test("a part cannot be copied into someone else's upload", async () => {
    const { h, aliceAuth, bobAuth } = await twoUsers();
    await h.signAndSend({ method: "PUT", path: "/bob-dst/own.bin", body: "bob", ...bobAuth });
    const create = await h.signAndSend({
      method: "POST", path: "/bob-dst/target.bin", query: { uploads: "" }, ...bobAuth,
    });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await create.text())![1]!;

    // Alice cannot write into Bob's multipart upload.
    const res = await h.signAndSend({
      method: "PUT",
      path: "/bob-dst/target.bin",
      query: { uploadId, partNumber: "1" },
      headers: { "x-amz-copy-source": "/bob-dst/own.bin" },
      ...aliceAuth,
    });
    expect(res.status).toBe(404);
  });
});
