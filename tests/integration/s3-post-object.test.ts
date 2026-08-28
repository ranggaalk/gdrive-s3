import { describe, expect, test } from "bun:test";
import { makeHarness } from "./_helpers.ts";
import { handleS3 } from "../../apps/server/src/s3/router.ts";
import {
  computeSignature,
  deriveSigningKey,
} from "../../apps/server/src/auth/sigv4-canonical.ts";

const BOUNDARY = "----DriveS3PostBoundary";

interface FormField {
  name: string;
  value: string;
}

function buildForm(fields: FormField[], file: { content: string; filename: string }): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const field of fields) {
    chunks.push(
      encoder.encode(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`,
      ),
    );
  }
  chunks.push(
    encoder.encode(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n${file.content}\r\n`,
    ),
  );
  chunks.push(encoder.encode(`--${BOUNDARY}--\r\n`));
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function amzNow(date = new Date()): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/** Sign a policy the way a trusted backend would before handing it to a browser. */
function signPolicy(
  secretAccessKey: string,
  accessKeyId: string,
  policy: unknown,
  date = new Date(),
): { fields: FormField[]; policyBase64: string } {
  const amzDate = amzNow(date);
  const dateStamp = amzDate.slice(0, 8);
  const credential = `${accessKeyId}/${dateStamp}/us-east-1/s3/aws4_request`;
  const policyBase64 = Buffer.from(JSON.stringify(policy), "utf8").toString("base64");
  const key = deriveSigningKey(secretAccessKey, dateStamp, "us-east-1", "s3");
  const signature = computeSignature(key, policyBase64);
  return {
    policyBase64,
    fields: [
      { name: "x-amz-algorithm", value: "AWS4-HMAC-SHA256" },
      { name: "x-amz-credential", value: credential },
      { name: "x-amz-date", value: amzDate },
      { name: "policy", value: policyBase64 },
      { name: "x-amz-signature", value: signature },
    ],
  };
}

function post(
  h: ReturnType<typeof makeHarness>,
  bucket: string,
  body: Uint8Array,
): Promise<Response> {
  const req = new Request(`http://localhost/${bucket}`, {
    method: "POST",
    headers: {
      host: "localhost",
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
    },
    body,
  });
  return handleS3(h.ctx, req, `req_${crypto.randomUUID()}`);
}

function futureExpiry(): string {
  return new Date(Date.now() + 3600_000).toISOString();
}

async function setup() {
  const h = makeHarness();
  const user = h.seedUser("a@x.com");
  const cred = h.seedCredential(user.id);
  const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
  await h.signAndSend({ method: "PUT", path: "/uploads", ...auth });
  return { h, user, cred, auth };
}

describe("PresignedPost integration", () => {
  test("uploads a file through a signed browser form", async () => {
    const { h, cred, auth } = await setup();
    const signed = signPolicy(cred.secretAccessKey, cred.accessKeyId, {
      expiration: futureExpiry(),
      conditions: [
        { bucket: "uploads" },
        ["starts-with", "$key", "inbox/"],
        { "x-amz-algorithm": "AWS4-HMAC-SHA256" },
        ["starts-with", "$x-amz-credential", ""],
        ["starts-with", "$x-amz-date", ""],
        ["content-length-range", 0, 4096],
      ],
    });

    const body = buildForm(
      [{ name: "key", value: "inbox/${filename}" }, ...signed.fields],
      { content: "posted from a browser", filename: "note.txt" },
    );
    const res = await post(h, "uploads", body);
    expect(res.status).toBe(204);
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);

    // The object is really there, readable over the normal SigV4 path.
    const get = await h.signAndSend({ method: "GET", path: "/uploads/inbox/note.txt", ...auth });
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("posted from a browser");
  });

  test("honours success_action_status 201 with a PostResponse body", async () => {
    const { h, cred } = await setup();
    const signed = signPolicy(cred.secretAccessKey, cred.accessKeyId, {
      expiration: futureExpiry(),
      conditions: [
        { bucket: "uploads" },
        ["starts-with", "$key", ""],
        ["starts-with", "$x-amz-algorithm", ""],
        ["starts-with", "$x-amz-credential", ""],
        ["starts-with", "$x-amz-date", ""],
        { success_action_status: "201" },
      ],
    });
    const body = buildForm(
      [
        { name: "key", value: "a.txt" },
        { name: "success_action_status", value: "201" },
        ...signed.fields,
      ],
      { content: "created", filename: "a.txt" },
    );
    const res = await post(h, "uploads", body);
    expect(res.status).toBe(201);
    const xml = await res.text();
    expect(xml).toContain("<Bucket>uploads</Bucket>");
    expect(xml).toContain("<Key>a.txt</Key>");
  });

  test("redirects to success_action_redirect with the result parameters", async () => {
    const { h, cred } = await setup();
    const signed = signPolicy(cred.secretAccessKey, cred.accessKeyId, {
      expiration: futureExpiry(),
      conditions: [
        { bucket: "uploads" },
        ["starts-with", "$key", ""],
        ["starts-with", "$x-amz-algorithm", ""],
        ["starts-with", "$x-amz-credential", ""],
        ["starts-with", "$x-amz-date", ""],
        ["starts-with", "$success_action_redirect", "https://app.example.com/"],
      ],
    });
    const body = buildForm(
      [
        { name: "key", value: "b.txt" },
        { name: "success_action_redirect", value: "https://app.example.com/done" },
        ...signed.fields,
      ],
      { content: "redirected", filename: "b.txt" },
    );
    const res = await post(h, "uploads", body);
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://app.example.com");
    expect(location.searchParams.get("bucket")).toBe("uploads");
    expect(location.searchParams.get("key")).toBe("b.txt");
  });

  test("refuses a non-http redirect target", async () => {
    const { h, cred } = await setup();
    const signed = signPolicy(cred.secretAccessKey, cred.accessKeyId, {
      expiration: futureExpiry(),
      conditions: [
        { bucket: "uploads" },
        ["starts-with", "$key", ""],
        ["starts-with", "$x-amz-algorithm", ""],
        ["starts-with", "$x-amz-credential", ""],
        ["starts-with", "$x-amz-date", ""],
        ["starts-with", "$success_action_redirect", ""],
      ],
    });
    const body = buildForm(
      [
        { name: "key", value: "c.txt" },
        { name: "success_action_redirect", value: "javascript:alert(1)" },
        ...signed.fields,
      ],
      { content: "x", filename: "c.txt" },
    );
    const res = await post(h, "uploads", body);
    // Falls back to the default success response rather than emitting the URI.
    expect(res.status).toBe(204);
    expect(res.headers.get("location")).not.toContain("javascript:");
  });

  test("rejects a key outside the policy prefix", async () => {
    const { h, cred } = await setup();
    const signed = signPolicy(cred.secretAccessKey, cred.accessKeyId, {
      expiration: futureExpiry(),
      conditions: [
        { bucket: "uploads" },
        ["starts-with", "$key", "inbox/"],
        ["starts-with", "$x-amz-algorithm", ""],
        ["starts-with", "$x-amz-credential", ""],
        ["starts-with", "$x-amz-date", ""],
      ],
    });
    const body = buildForm(
      [{ name: "key", value: "elsewhere/evil.txt" }, ...signed.fields],
      { content: "nope", filename: "evil.txt" },
    );
    const res = await post(h, "uploads", body);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("AccessDenied");
  });

  test("rejects a policy signed for a different bucket", async () => {
    const { h, cred, auth } = await setup();
    await h.signAndSend({ method: "PUT", path: "/other", ...auth });
    const signed = signPolicy(cred.secretAccessKey, cred.accessKeyId, {
      expiration: futureExpiry(),
      conditions: [
        { bucket: "other" },
        ["starts-with", "$key", ""],
        ["starts-with", "$x-amz-algorithm", ""],
        ["starts-with", "$x-amz-credential", ""],
        ["starts-with", "$x-amz-date", ""],
      ],
    });
    const body = buildForm([{ name: "key", value: "a.txt" }, ...signed.fields], {
      content: "x",
      filename: "a.txt",
    });
    const res = await post(h, "uploads", body);
    expect(res.status).toBe(403);
  });

  test("rejects a tampered policy", async () => {
    const { h, cred } = await setup();
    const signed = signPolicy(cred.secretAccessKey, cred.accessKeyId, {
      expiration: futureExpiry(),
      conditions: [
        { bucket: "uploads" },
        ["starts-with", "$key", "inbox/"],
        ["starts-with", "$x-amz-algorithm", ""],
        ["starts-with", "$x-amz-credential", ""],
        ["starts-with", "$x-amz-date", ""],
      ],
    });
    // Swap in a policy that allows any key, keeping the original signature.
    const forged = Buffer.from(
      JSON.stringify({
        expiration: futureExpiry(),
        conditions: [{ bucket: "uploads" }, ["starts-with", "$key", ""]],
      }),
      "utf8",
    ).toString("base64");
    const fields = signed.fields.map((f) =>
      f.name === "policy" ? { name: "policy", value: forged } : f,
    );
    const body = buildForm([{ name: "key", value: "anywhere.txt" }, ...fields], {
      content: "x",
      filename: "anywhere.txt",
    });
    const res = await post(h, "uploads", body);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("SignatureDoesNotMatch");
  });

  test("rejects an extra field the policy does not cover", async () => {
    const { h, cred } = await setup();
    const signed = signPolicy(cred.secretAccessKey, cred.accessKeyId, {
      expiration: futureExpiry(),
      conditions: [
        { bucket: "uploads" },
        ["starts-with", "$key", ""],
        ["starts-with", "$x-amz-algorithm", ""],
        ["starts-with", "$x-amz-credential", ""],
        ["starts-with", "$x-amz-date", ""],
      ],
    });
    const body = buildForm(
      [
        { name: "key", value: "a.txt" },
        { name: "x-amz-meta-smuggled", value: "yes" },
        ...signed.fields,
      ],
      { content: "x", filename: "a.txt" },
    );
    const res = await post(h, "uploads", body);
    expect(res.status).toBe(403);
  });

  test("rejects an expired policy", async () => {
    const { h, cred } = await setup();
    const signed = signPolicy(cred.secretAccessKey, cred.accessKeyId, {
      expiration: new Date(Date.now() - 1000).toISOString(),
      conditions: [
        { bucket: "uploads" },
        ["starts-with", "$key", ""],
        ["starts-with", "$x-amz-algorithm", ""],
        ["starts-with", "$x-amz-credential", ""],
        ["starts-with", "$x-amz-date", ""],
      ],
    });
    const body = buildForm([{ name: "key", value: "a.txt" }, ...signed.fields], {
      content: "x",
      filename: "a.txt",
    });
    const res = await post(h, "uploads", body);
    expect(res.status).toBe(403);
  });

  test("enforces the content-length-range floor", async () => {
    const { h, cred, auth } = await setup();
    const signed = signPolicy(cred.secretAccessKey, cred.accessKeyId, {
      expiration: futureExpiry(),
      conditions: [
        { bucket: "uploads" },
        ["starts-with", "$key", ""],
        ["starts-with", "$x-amz-algorithm", ""],
        ["starts-with", "$x-amz-credential", ""],
        ["starts-with", "$x-amz-date", ""],
        ["content-length-range", 100, 4096],
      ],
    });
    const body = buildForm([{ name: "key", value: "small.txt" }, ...signed.fields], {
      content: "too short",
      filename: "small.txt",
    });
    const res = await post(h, "uploads", body);
    expect(res.status).toBe(400);

    // Nothing was committed to the namespace.
    const get = await h.signAndSend({ method: "GET", path: "/uploads/small.txt", ...auth });
    expect(get.status).toBe(404);
  });

  test("enforces the content-length-range ceiling", async () => {
    const { h, cred } = await setup();
    const signed = signPolicy(cred.secretAccessKey, cred.accessKeyId, {
      expiration: futureExpiry(),
      conditions: [
        { bucket: "uploads" },
        ["starts-with", "$key", ""],
        ["starts-with", "$x-amz-algorithm", ""],
        ["starts-with", "$x-amz-credential", ""],
        ["starts-with", "$x-amz-date", ""],
        ["content-length-range", 0, 16],
      ],
    });
    const body = buildForm([{ name: "key", value: "big.txt" }, ...signed.fields], {
      content: "x".repeat(500),
      filename: "big.txt",
    });
    const res = await post(h, "uploads", body);
    expect(res.status).toBe(400);
  });

  test("rejects an unknown access key id", async () => {
    const { h } = await setup();
    const signed = signPolicy("some-secret", "AKIADOESNOTEXIST0000", {
      expiration: futureExpiry(),
      conditions: [
        { bucket: "uploads" },
        ["starts-with", "$key", ""],
        ["starts-with", "$x-amz-algorithm", ""],
        ["starts-with", "$x-amz-credential", ""],
        ["starts-with", "$x-amz-date", ""],
      ],
    });
    const body = buildForm([{ name: "key", value: "a.txt" }, ...signed.fields], {
      content: "x",
      filename: "a.txt",
    });
    const res = await post(h, "uploads", body);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("InvalidAccessKeyId");
  });

  test("a ${filename} key template cannot escape its prefix", async () => {
    const { h, cred, auth } = await setup();
    const signed = signPolicy(cred.secretAccessKey, cred.accessKeyId, {
      expiration: futureExpiry(),
      conditions: [
        { bucket: "uploads" },
        ["starts-with", "$key", "inbox/"],
        ["starts-with", "$x-amz-algorithm", ""],
        ["starts-with", "$x-amz-credential", ""],
        ["starts-with", "$x-amz-date", ""],
      ],
    });
    const body = buildForm(
      [{ name: "key", value: "inbox/${filename}" }, ...signed.fields],
      { content: "traversal", filename: "../../escaped.txt" },
    );
    const res = await post(h, "uploads", body);
    expect(res.status).toBe(204);
    // Only the final path segment survives, so the object stays under inbox/.
    const get = await h.signAndSend({ method: "GET", path: "/uploads/inbox/escaped.txt", ...auth });
    expect(get.status).toBe(200);
  });

  test("bulk delete still routes to SigV4, not the POST policy path", async () => {
    const { h, auth } = await setup();
    await h.signAndSend({ method: "PUT", path: "/uploads/gone.txt", body: "bye", ...auth });
    const res = await h.signAndSend({
      method: "POST",
      path: "/uploads",
      query: { delete: "" },
      headers: { "content-type": "application/xml" },
      body: "<Delete><Object><Key>gone.txt</Key></Object></Delete>",
      ...auth,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Key>gone.txt</Key>");
  });

  test("accepts a body built by the platform's own FormData encoder", async () => {
    const { h, user, cred, auth } = await setup();
    const credRow = h.ctx.repos.credentials.findActiveByAccessKeyId(cred.accessKeyId)!;
    const created = h.ctx.presignedUrlService.createPost({
      userId: user.id,
      credentialId: credRow.id,
      bucketName: "uploads",
      keyPrefix: "inbox/",
      expiresSeconds: 3600,
      maxBytes: 25 * 1024 * 1024,
    });

    // Let the runtime pick the boundary and encode the parts, rather than the
    // hand-rolled builder above — this is what a real browser submits.
    const formData = new FormData();
    for (const [name, value] of Object.entries(created.fields)) formData.append(name, value);
    formData.append("file", new File(["real browser upload"], "hello.txt", { type: "text/plain" }));

    const encoded = new Request("http://localhost/uploads", { method: "POST", body: formData });
    const headers = new Headers(encoded.headers);
    headers.set("host", "localhost");
    const res = await handleS3(
      h.ctx,
      new Request("http://localhost/uploads", {
        method: "POST",
        headers,
        body: encoded.body,
        duplex: "half",
      } as RequestInit),
      "req_formdata",
    );
    expect(res.status).toBe(204);

    const get = await h.signAndSend({ method: "GET", path: "/uploads/inbox/hello.txt", ...auth });
    expect(await get.text()).toBe("real browser upload");
  });

  test("the dashboard generator produces a form the gateway accepts", async () => {
    const { h, user, cred, auth } = await setup();
    const created = h.ctx.presignedUrlService.createPost({
      userId: user.id,
      credentialId: h.ctx.repos.credentials.findActiveByAccessKeyId(cred.accessKeyId)!.id,
      bucketName: "uploads",
      keyPrefix: "dropbox/",
      expiresSeconds: 900,
      maxBytes: 1024,
    });
    expect(created.url).toBe("http://localhost/uploads");
    expect(created.keyTemplate).toBe("dropbox/${filename}");

    const fields = Object.entries(created.fields).map(([name, value]) => ({ name, value }));
    const res = await post(
      h,
      "uploads",
      buildForm(fields, { content: "round trip", filename: "rt.txt" }),
    );
    expect(res.status).toBe(204);

    const get = await h.signAndSend({ method: "GET", path: "/uploads/dropbox/rt.txt", ...auth });
    expect(await get.text()).toBe("round trip");
  });
});
