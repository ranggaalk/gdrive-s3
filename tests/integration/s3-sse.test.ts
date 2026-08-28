import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { makeHarness } from "./_helpers.ts";

const CUSTOMER_KEY = Buffer.alloc(32, 42);
const CUSTOMER_KEY_B64 = CUSTOMER_KEY.toString("base64");
const CUSTOMER_KEY_MD5 = createHash("md5").update(CUSTOMER_KEY).digest("base64");

const SSE_C_HEADERS = {
  "x-amz-server-side-encryption-customer-algorithm": "AES256",
  "x-amz-server-side-encryption-customer-key": CUSTOMER_KEY_B64,
  "x-amz-server-side-encryption-customer-key-md5": CUSTOMER_KEY_MD5,
};

async function setup() {
  const h = makeHarness();
  const user = h.seedUser("owner@x.com");
  const cred = h.seedCredential(user.id);
  const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
  await h.signAndSend({ method: "PUT", path: "/vault", ...auth });
  return { h, user, auth };
}

/** What actually landed in Drive, so "encrypted" can be proven rather than
 *  assumed from a response header. */
function storedBytes(h: ReturnType<typeof makeHarness>, key: string): Buffer {
  const bucketId = h.ctx.repos.buckets.listByName("vault")[0]!.id;
  const object = h.ctx.repos.objects.findByKey(bucketId, key)!;
  return Buffer.from(h.storage.contentOf(object.drive_file_id));
}

describe("SSE-S3", () => {
  test("encrypts at rest and reads back identically", async () => {
    const { h, auth } = await setup();
    const body = "sensitive contents";

    const put = await h.signAndSend({
      method: "PUT",
      path: "/vault/note.txt",
      headers: { "x-amz-server-side-encryption": "AES256" },
      body,
      ...auth,
    });
    expect(put.status).toBe(200);
    expect(put.headers.get("x-amz-server-side-encryption")).toBe("AES256");

    // The bytes in Drive are not the plaintext.
    const stored = storedBytes(h, "note.txt");
    expect(stored.length).toBe(body.length);
    expect(stored.toString("utf8")).not.toBe(body);

    const get = await h.signAndSend({ method: "GET", path: "/vault/note.txt", ...auth });
    expect(get.status).toBe(200);
    expect(await get.text()).toBe(body);
    expect(get.headers.get("x-amz-server-side-encryption")).toBe("AES256");
  });

  test("the ETag stays the MD5 of the plaintext", async () => {
    const { h, auth } = await setup();
    const body = "etag stability";
    const expected = createHash("md5").update(body).digest("hex");

    const put = await h.signAndSend({
      method: "PUT",
      path: "/vault/etag.txt",
      headers: { "x-amz-server-side-encryption": "AES256" },
      body,
      ...auth,
    });
    expect(put.headers.get("etag")).toBe(`"${expected}"`);
  });

  test("HEAD reports the encryption without reading bytes", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({
      method: "PUT", path: "/vault/h.txt",
      headers: { "x-amz-server-side-encryption": "AES256" }, body: "x", ...auth,
    });
    const head = await h.signAndSend({ method: "HEAD", path: "/vault/h.txt", ...auth });
    expect(head.status).toBe(200);
    expect(head.headers.get("x-amz-server-side-encryption")).toBe("AES256");
  });

  test("an unencrypted object reports no encryption headers", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({ method: "PUT", path: "/vault/plain.txt", body: "clear", ...auth });
    const get = await h.signAndSend({ method: "GET", path: "/vault/plain.txt", ...auth });
    expect(get.headers.has("x-amz-server-side-encryption")).toBe(false);
    expect(storedBytes(h, "plain.txt").toString("utf8")).toBe("clear");
  });
});

describe("ranged reads of encrypted objects", () => {
  test("every range offset decrypts correctly, including mid-block starts", async () => {
    const { h, auth } = await setup();
    // Varied bytes so a decryption slip corrupts rather than merely truncates.
    const body = Buffer.alloc(5000);
    for (let i = 0; i < body.length; i++) body[i] = (i * 53 + 7) % 256;

    await h.signAndSend({
      method: "PUT",
      path: "/vault/big.bin",
      headers: { "x-amz-server-side-encryption": "AES256" },
      body: new Uint8Array(body),
      ...auth,
    });

    // 1 and 17 are deliberately not multiples of the 16-byte AES block.
    const ranges: Array<[number, number]> = [
      [0, 99], [1, 100], [15, 47], [16, 63], [17, 200], [1000, 1999], [4990, 4999],
    ];
    for (const [start, end] of ranges) {
      const res = await h.signAndSend({
        method: "GET",
        path: "/vault/big.bin",
        headers: { range: `bytes=${start}-${end}` },
        ...auth,
      });
      expect(res.status).toBe(206);
      const received = Buffer.from(await res.arrayBuffer());
      expect(received.equals(body.subarray(start, end + 1))).toBe(true);
    }
  });

  test("a suffix range decrypts", async () => {
    const { h, auth } = await setup();
    const body = Buffer.alloc(2000, 0);
    for (let i = 0; i < body.length; i++) body[i] = i % 251;
    await h.signAndSend({
      method: "PUT", path: "/vault/suffix.bin",
      headers: { "x-amz-server-side-encryption": "AES256" },
      body: new Uint8Array(body), ...auth,
    });

    const res = await h.signAndSend({
      method: "GET", path: "/vault/suffix.bin",
      headers: { range: "bytes=-100" }, ...auth,
    });
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer()).equals(body.subarray(1900))).toBe(true);
  });
});

describe("SSE-KMS", () => {
  test("encrypts under a named CMK and echoes the key id", async () => {
    const { h, user, auth } = await setup();
    const cmk = h.ctx.kms.create({ userId: user.id, alias: "records" });

    const put = await h.signAndSend({
      method: "PUT",
      path: "/vault/kms.txt",
      headers: {
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": cmk.id,
      },
      body: "kms protected",
      ...auth,
    });
    expect(put.status).toBe(200);
    expect(put.headers.get("x-amz-server-side-encryption")).toBe("aws:kms");
    expect(put.headers.get("x-amz-server-side-encryption-aws-kms-key-id")).toBe(cmk.id);

    expect(storedBytes(h, "kms.txt").toString("utf8")).not.toBe("kms protected");
    const get = await h.signAndSend({ method: "GET", path: "/vault/kms.txt", ...auth });
    expect(await get.text()).toBe("kms protected");
  });

  test("accepts an alias reference", async () => {
    const { h, user, auth } = await setup();
    h.ctx.kms.create({ userId: user.id, alias: "by-alias" });

    const put = await h.signAndSend({
      method: "PUT",
      path: "/vault/alias.txt",
      headers: {
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": "alias/by-alias",
      },
      body: "aliased",
      ...auth,
    });
    expect(put.status).toBe(200);
    expect(await (await h.signAndSend({ method: "GET", path: "/vault/alias.txt", ...auth })).text())
      .toBe("aliased");
  });

  test("objects stay readable after the CMK is rotated", async () => {
    const { h, user, auth } = await setup();
    const cmk = h.ctx.kms.create({ userId: user.id, alias: "rotating" });

    await h.signAndSend({
      method: "PUT", path: "/vault/before.txt",
      headers: {
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": cmk.id,
      },
      body: "written before rotation", ...auth,
    });

    h.ctx.kms.rotate(user.id, cmk.id);

    // The whole point of versioned key material: rotation must not strand data.
    const get = await h.signAndSend({ method: "GET", path: "/vault/before.txt", ...auth });
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("written before rotation");

    // And new writes still work, under the new version.
    await h.signAndSend({
      method: "PUT", path: "/vault/after.txt",
      headers: {
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": cmk.id,
      },
      body: "written after rotation", ...auth,
    });
    expect(await (await h.signAndSend({ method: "GET", path: "/vault/after.txt", ...auth })).text())
      .toBe("written after rotation");
  });

  test("an unknown or disabled key is refused", async () => {
    const { h, user, auth } = await setup();
    const unknown = await h.signAndSend({
      method: "PUT", path: "/vault/x.txt",
      headers: {
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": "kms_nope",
      },
      body: "x", ...auth,
    });
    expect(unknown.status).toBe(400);

    const cmk = h.ctx.kms.create({ userId: user.id, alias: "off" });
    h.ctx.kms.setStatus(user.id, cmk.id, "disabled");
    const disabled = await h.signAndSend({
      method: "PUT", path: "/vault/y.txt",
      headers: {
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": cmk.id,
      },
      body: "y", ...auth,
    });
    expect(disabled.status).toBe(400);
  });

  test("aws:kms with no key and no bucket default is refused", async () => {
    const { h, auth } = await setup();
    const res = await h.signAndSend({
      method: "PUT", path: "/vault/z.txt",
      headers: { "x-amz-server-side-encryption": "aws:kms" },
      body: "z", ...auth,
    });
    expect(res.status).toBe(400);
  });
});

describe("SSE-C", () => {
  test("round-trips with the customer key", async () => {
    const { h, auth } = await setup();
    const put = await h.signAndSend({
      method: "PUT", path: "/vault/c.txt", headers: SSE_C_HEADERS, body: "customer held", ...auth,
    });
    expect(put.status).toBe(200);
    expect(put.headers.get("x-amz-server-side-encryption-customer-key-md5")).toBe(CUSTOMER_KEY_MD5);
    expect(storedBytes(h, "c.txt").toString("utf8")).not.toBe("customer held");

    const get = await h.signAndSend({
      method: "GET", path: "/vault/c.txt", headers: SSE_C_HEADERS, ...auth,
    });
    expect(await get.text()).toBe("customer held");
  });

  test("the key is never persisted, only its digest", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({
      method: "PUT", path: "/vault/c.txt", headers: SSE_C_HEADERS, body: "secret", ...auth,
    });
    const bucketId = h.ctx.repos.buckets.listByName("vault")[0]!.id;
    const object = h.ctx.repos.objects.findByKey(bucketId, "c.txt")!;
    const row = h.ctx.repos.objectEncryption.find(object.id)!;
    expect(row.customer_key_md5).toBe(CUSTOMER_KEY_MD5);
    expect(row.wrapped_data_key).toBeNull();
    expect(JSON.stringify(row)).not.toContain(CUSTOMER_KEY_B64);
  });

  test("reading without the key is refused", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({
      method: "PUT", path: "/vault/c.txt", headers: SSE_C_HEADERS, body: "secret", ...auth,
    });
    const res = await h.signAndSend({ method: "GET", path: "/vault/c.txt", ...auth });
    expect(res.status).toBe(400);
  });

  test("reading with the wrong key is refused rather than returning garbage", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({
      method: "PUT", path: "/vault/c.txt", headers: SSE_C_HEADERS, body: "secret", ...auth,
    });

    const wrongKey = Buffer.alloc(32, 99);
    const res = await h.signAndSend({
      method: "GET",
      path: "/vault/c.txt",
      headers: {
        "x-amz-server-side-encryption-customer-algorithm": "AES256",
        "x-amz-server-side-encryption-customer-key": wrongKey.toString("base64"),
        "x-amz-server-side-encryption-customer-key-md5": createHash("md5").update(wrongKey).digest("base64"),
      },
      ...auth,
    });
    expect(res.status).toBe(403);
  });

  test("a key sent for a plaintext object is refused", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({ method: "PUT", path: "/vault/plain.txt", body: "clear", ...auth });
    const res = await h.signAndSend({
      method: "GET", path: "/vault/plain.txt", headers: SSE_C_HEADERS, ...auth,
    });
    expect(res.status).toBe(400);
  });

  test("a ranged read with the customer key decrypts", async () => {
    const { h, auth } = await setup();
    const body = Buffer.alloc(1000);
    for (let i = 0; i < body.length; i++) body[i] = (i * 13) % 256;
    await h.signAndSend({
      method: "PUT", path: "/vault/cr.bin", headers: SSE_C_HEADERS,
      body: new Uint8Array(body), ...auth,
    });
    const res = await h.signAndSend({
      method: "GET", path: "/vault/cr.bin",
      headers: { ...SSE_C_HEADERS, range: "bytes=101-300" }, ...auth,
    });
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer()).equals(body.subarray(101, 301))).toBe(true);
  });
});

describe("bucket default encryption", () => {
  test("applies to writes that name no encryption of their own", async () => {
    const { h, auth } = await setup();
    const put = await h.signAndSend({
      method: "PUT",
      path: "/vault",
      query: { encryption: "" },
      body: "<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>",
      ...auth,
    });
    expect(put.status).toBe(200);

    // No SSE header on this PUT at all.
    const write = await h.signAndSend({
      method: "PUT", path: "/vault/auto.txt", body: "auto encrypted", ...auth,
    });
    expect(write.headers.get("x-amz-server-side-encryption")).toBe("AES256");
    expect(storedBytes(h, "auto.txt").toString("utf8")).not.toBe("auto encrypted");
    expect(await (await h.signAndSend({ method: "GET", path: "/vault/auto.txt", ...auth })).text())
      .toBe("auto encrypted");
  });

  test("round-trips through GET and DELETE", async () => {
    const { h, auth } = await setup();
    expect((await h.signAndSend({
      method: "GET", path: "/vault", query: { encryption: "" }, ...auth,
    })).status).toBe(404);

    await h.signAndSend({
      method: "PUT", path: "/vault", query: { encryption: "" },
      body: "<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>",
      ...auth,
    });
    const get = await h.signAndSend({
      method: "GET", path: "/vault", query: { encryption: "" }, ...auth,
    });
    expect(await get.text()).toContain("<SSEAlgorithm>AES256</SSEAlgorithm>");

    expect((await h.signAndSend({
      method: "DELETE", path: "/vault", query: { encryption: "" }, ...auth,
    })).status).toBe(204);

    // Writes go back to plaintext.
    await h.signAndSend({ method: "PUT", path: "/vault/after.txt", body: "plain again", ...auth });
    expect(storedBytes(h, "after.txt").toString("utf8")).toBe("plain again");
  });

  test("an explicit request header overrides the bucket default", async () => {
    const { h, user, auth } = await setup();
    const cmk = h.ctx.kms.create({ userId: user.id, alias: "override" });
    await h.signAndSend({
      method: "PUT", path: "/vault", query: { encryption: "" },
      body: "<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>",
      ...auth,
    });

    const put = await h.signAndSend({
      method: "PUT", path: "/vault/override.txt",
      headers: {
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": cmk.id,
      },
      body: "kms wins", ...auth,
    });
    expect(put.headers.get("x-amz-server-side-encryption")).toBe("aws:kms");
  });

  test("a default naming an unknown KMS key is refused at configuration time", async () => {
    const { h, auth } = await setup();
    const res = await h.signAndSend({
      method: "PUT", path: "/vault", query: { encryption: "" },
      body: "<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>aws:kms</SSEAlgorithm><KMSMasterKeyID>kms_missing</KMSMasterKeyID></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>",
      ...auth,
    });
    expect(res.status).toBe(400);
  });

  test("a malformed configuration is rejected", async () => {
    const { h, auth } = await setup();
    const res = await h.signAndSend({
      method: "PUT", path: "/vault", query: { encryption: "" },
      body: "<ServerSideEncryptionConfiguration><Rule/></ServerSideEncryptionConfiguration>",
      ...auth,
    });
    expect(res.status).toBe(400);
  });
});

describe("encrypted multipart uploads", () => {
  test("assembles and reads back, including a ranged read", async () => {
    const { h, user, auth } = await setup();
    const cmk = h.ctx.kms.create({ userId: user.id, alias: "multipart" });

    const create = await h.signAndSend({
      method: "POST",
      path: "/vault/multi.bin",
      query: { uploads: "" },
      headers: {
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": cmk.id,
      },
      ...auth,
    });
    expect(create.status).toBe(200);
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await create.text())![1]!;

    // Two parts, the first at the 5 MiB minimum.
    const partOne = Buffer.alloc(5 * 1024 * 1024);
    for (let i = 0; i < partOne.length; i++) partOne[i] = i % 256;
    const partTwo = Buffer.from("the tail of the object");

    const etags: string[] = [];
    for (const [index, part] of [partOne, partTwo].entries()) {
      const res = await h.signAndSend({
        method: "PUT",
        path: "/vault/multi.bin",
        query: { uploadId, partNumber: String(index + 1) },
        body: new Uint8Array(part),
        ...auth,
      });
      expect(res.status).toBe(200);
      etags.push(res.headers.get("etag")!);
    }

    const complete = await h.signAndSend({
      method: "POST",
      path: "/vault/multi.bin",
      query: { uploadId },
      body:
        "<CompleteMultipartUpload>" +
        etags.map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`).join("") +
        "</CompleteMultipartUpload>",
      ...auth,
    });
    expect(complete.status).toBe(200);

    const whole = Buffer.concat([partOne, partTwo]);
    expect(storedBytes(h, "multi.bin").equals(whole)).toBe(false);

    const get = await h.signAndSend({ method: "GET", path: "/vault/multi.bin", ...auth });
    expect(Buffer.from(await get.arrayBuffer()).equals(whole)).toBe(true);

    // A range spanning the part boundary must decrypt as one contiguous
    // keystream, which is why the whole object is encrypted at assembly.
    const boundary = partOne.length;
    const ranged = await h.signAndSend({
      method: "GET",
      path: "/vault/multi.bin",
      headers: { range: `bytes=${boundary - 50}-${boundary + 10}` },
      ...auth,
    });
    expect(ranged.status).toBe(206);
    expect(Buffer.from(await ranged.arrayBuffer()).equals(whole.subarray(boundary - 50, boundary + 11))).toBe(true);
  });
});
