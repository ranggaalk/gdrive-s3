import { afterEach, describe, expect, test } from "bun:test";
import { makeHarness } from "../integration/_helpers.ts";
import { SigV4PresignedVerifier } from "../../apps/server/src/auth/s3-sigv4-presigned.ts";
import {
  UNSIGNED_PAYLOAD,
  buildCanonicalRequest,
  buildStringToSign,
  computeSignature,
  deriveSigningKey,
} from "../../apps/server/src/auth/sigv4-canonical.ts";

const contexts: Array<ReturnType<typeof makeHarness>["ctx"]> = [];
afterEach(() => {
  while (contexts.length) contexts.pop()!.db.close();
});

function amzDate(now = new Date()): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function signedQuery(input: {
  accessKeyId: string;
  secretAccessKey: string;
  method?: string;
  path?: string;
  expires?: number;
  date?: Date;
}): { query: URLSearchParams; headers: Headers } {
  const date = amzDate(input.date);
  const dateStamp = date.slice(0, 8);
  const scope = `${dateStamp}/us-east-1/s3/aws4_request`;
  const query = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.accessKeyId}/${scope}`,
    "X-Amz-Date": date,
    "X-Amz-Expires": String(input.expires ?? 60),
    "X-Amz-SignedHeaders": "host",
  });
  const headers = new Headers({ host: "localhost" });
  const { canonicalRequest } = buildCanonicalRequest({
    method: input.method ?? "GET",
    path: input.path ?? "/bucket/key",
    query,
    headers,
    signedHeaderNames: ["host"],
    payloadHash: UNSIGNED_PAYLOAD,
  });
  const sts = buildStringToSign({ amzDate: date, scope, canonicalRequest });
  const key = deriveSigningKey(input.secretAccessKey, dateStamp, "us-east-1", "s3");
  query.set("X-Amz-Signature", computeSignature(key, sts));
  return { query, headers };
}

describe("SigV4PresignedVerifier", () => {
  test("accepts a valid query signature", () => {
    const h = makeHarness();
    contexts.push(h.ctx);
    const user = h.seedUser("pre@x.com");
    const credential = h.seedCredential(user.id);
    const request = signedQuery(credential);
    const verifier = new SigV4PresignedVerifier(h.ctx.config, h.ctx.repos.credentials);
    const result = verifier.verify({ method: "GET", pathname: "/bucket/key", ...request });
    expect(result).toMatchObject({ ok: true, userId: user.id });
  });

  test("rejects tampering and expiry outside configured bounds", () => {
    const h = makeHarness({ presignedMaxExpiresSeconds: 120 });
    contexts.push(h.ctx);
    const user = h.seedUser("pre2@x.com");
    const credential = h.seedCredential(user.id);
    const verifier = new SigV4PresignedVerifier(h.ctx.config, h.ctx.repos.credentials);

    const tampered = signedQuery(credential);
    tampered.query.set("extra", "changed");
    expect(
      verifier.verify({ method: "GET", pathname: "/bucket/key", ...tampered }),
    ).toMatchObject({ ok: false, failure: "SignatureDoesNotMatch" });

    const tooLong = signedQuery({ ...credential, expires: 121 });
    expect(
      verifier.verify({ method: "GET", pathname: "/bucket/key", ...tooLong }),
    ).toMatchObject({ ok: false, failure: "MalformedAuthorization" });

    const withoutSignedHost = signedQuery(credential);
    withoutSignedHost.query.set("X-Amz-SignedHeaders", "x-test");
    expect(
      verifier.verify({ method: "GET", pathname: "/bucket/key", ...withoutSignedHost }),
    ).toMatchObject({ ok: false, failure: "MalformedAuthorization" });
  });

  test("rejects an expired URL", () => {
    const h = makeHarness();
    contexts.push(h.ctx);
    const user = h.seedUser("pre3@x.com");
    const credential = h.seedCredential(user.id);
    const expired = signedQuery({ ...credential, date: new Date(Date.now() - 120_000) });
    const verifier = new SigV4PresignedVerifier(h.ctx.config, h.ctx.repos.credentials);
    expect(
      verifier.verify({ method: "GET", pathname: "/bucket/key", ...expired }),
    ).toMatchObject({ ok: false, failure: "RequestTimeTooSkewed" });
  });
});
