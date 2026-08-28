import { describe, expect, test } from "bun:test";
import {
  POST_ALGORITHM,
  checkPostPolicy,
  contentLengthRange,
  parsePostCredential,
  parsePostPolicy,
  PostPolicyError,
  verifyPostSignature,
} from "../../apps/server/src/auth/s3-post-policy.ts";
import {
  computeSignature,
  deriveSigningKey,
} from "../../apps/server/src/auth/sigv4-canonical.ts";

function encodePolicy(document: unknown): string {
  return Buffer.from(JSON.stringify(document), "utf8").toString("base64");
}

const FUTURE = new Date(Date.now() + 3600_000).toISOString();

describe("POST policy parsing", () => {
  test("accepts the object and array condition forms", () => {
    const policy = parsePostPolicy(
      encodePolicy({
        expiration: FUTURE,
        conditions: [
          { bucket: "uploads" },
          ["starts-with", "$key", "user/eric/"],
          ["eq", "$acl", "private"],
          ["content-length-range", 0, 1024],
        ],
      }),
    );
    expect(policy.conditions).toEqual([
      { kind: "eq", field: "bucket", value: "uploads" },
      { kind: "starts-with", field: "key", prefix: "user/eric/" },
      { kind: "eq", field: "acl", value: "private" },
      { kind: "content-length-range", min: 0, max: 1024 },
    ]);
  });

  test("lowercases condition field names so matching is case-insensitive", () => {
    const policy = parsePostPolicy(
      encodePolicy({ expiration: FUTURE, conditions: [{ "Content-Type": "text/plain" }] }),
    );
    expect(policy.conditions[0]).toEqual({
      kind: "eq",
      field: "content-type",
      value: "text/plain",
    });
  });

  test("rejects malformed documents", () => {
    const cases: unknown[] = [
      { conditions: [] }, // no expiration
      { expiration: FUTURE }, // no conditions
      { expiration: "not-a-date", conditions: [] },
      { expiration: FUTURE, conditions: [["unknown-op", "$key", "x"]] },
      { expiration: FUTURE, conditions: [["starts-with", "key", "x"]] }, // missing $
      { expiration: FUTURE, conditions: [["content-length-range", 10, 5]] }, // max < min
      { expiration: FUTURE, conditions: [["content-length-range", -1, 5]] },
      { expiration: FUTURE, conditions: [{ a: "1", b: "2" }] }, // two fields in one object
      { expiration: FUTURE, conditions: [{ acl: 5 }] }, // non-string value
    ];
    for (const document of cases) {
      expect(() => parsePostPolicy(encodePolicy(document))).toThrow(PostPolicyError);
    }
  });

  test("rejects non-JSON and oversized documents", () => {
    expect(() => parsePostPolicy(Buffer.from("not json", "utf8").toString("base64"))).toThrow(
      PostPolicyError,
    );
    const huge = encodePolicy({
      expiration: FUTURE,
      conditions: [{ bucket: "x".repeat(30_000) }],
    });
    expect(() => parsePostPolicy(huge)).toThrow(PostPolicyError);
  });

  test("rejects a document with too many conditions", () => {
    const conditions = Array.from({ length: 65 }, (_, i) => ({ [`f${i}`]: "v" }));
    expect(() => parsePostPolicy(encodePolicy({ expiration: FUTURE, conditions }))).toThrow(
      PostPolicyError,
    );
  });

  test("reads the content-length-range back out", () => {
    const policy = parsePostPolicy(
      encodePolicy({ expiration: FUTURE, conditions: [["content-length-range", 5, 50]] }),
    );
    expect(contentLengthRange(policy)).toEqual({ min: 5, max: 50 });
    const none = parsePostPolicy(encodePolicy({ expiration: FUTURE, conditions: [] }));
    expect(contentLengthRange(none)).toBeNull();
  });
});

describe("POST policy evaluation", () => {
  const policy = parsePostPolicy(
    encodePolicy({
      expiration: FUTURE,
      conditions: [
        { bucket: "uploads" },
        ["starts-with", "$key", "user/eric/"],
        { acl: "private" },
        ["content-length-range", 0, 1024],
      ],
    }),
  );

  function check(fields: Record<string, string>, submitted?: string[]) {
    return checkPostPolicy({
      policy,
      fields: new Map(Object.entries(fields)),
      submittedFields: submitted ?? Object.keys(fields).filter((f) => f !== "bucket"),
    });
  }

  test("allows a submission that satisfies every condition", () => {
    expect(check({ bucket: "uploads", key: "user/eric/report.pdf", acl: "private" })).toBeNull();
  });

  test("rejects a key outside the allowed prefix", () => {
    expect(check({ bucket: "uploads", key: "user/mallory/x", acl: "private" })).toContain("key");
  });

  test("rejects a mismatched exact condition", () => {
    expect(
      check({ bucket: "uploads", key: "user/eric/a", acl: "public-read" }),
    ).toContain("acl");
  });

  test("rejects a bucket the policy was not signed for", () => {
    expect(check({ bucket: "other", key: "user/eric/a", acl: "private" })).toContain("bucket");
  });

  test("rejects a submission missing a field the policy requires", () => {
    expect(check({ bucket: "uploads", key: "user/eric/a" })).toContain("acl");
  });

  test("rejects an extra field the policy does not cover", () => {
    const reason = check({
      bucket: "uploads",
      key: "user/eric/a",
      acl: "private",
      "x-amz-meta-smuggled": "yes",
    });
    expect(reason).toContain("x-amz-meta-smuggled");
  });

  test("ignores the fields that never need a condition", () => {
    expect(
      check({
        bucket: "uploads",
        key: "user/eric/a",
        acl: "private",
        policy: "…",
        "x-amz-signature": "…",
        file: "…",
        "x-ignore-widget": "…",
      }),
    ).toBeNull();
  });

  test("rejects an expired policy", () => {
    const expired = parsePostPolicy(
      encodePolicy({
        expiration: new Date(Date.now() - 1000).toISOString(),
        conditions: [{ bucket: "uploads" }],
      }),
    );
    expect(
      checkPostPolicy({
        policy: expired,
        fields: new Map([["bucket", "uploads"]]),
        submittedFields: [],
      }),
    ).toBe("Policy has expired");
  });

  test("an empty starts-with prefix matches anything", () => {
    const open = parsePostPolicy(
      encodePolicy({ expiration: FUTURE, conditions: [["starts-with", "$key", ""]] }),
    );
    expect(
      checkPostPolicy({
        policy: open,
        fields: new Map([["key", "literally/anything"]]),
        submittedFields: ["key"],
      }),
    ).toBeNull();
  });
});

describe("POST credential and signature", () => {
  test("parses a well-formed credential", () => {
    expect(parsePostCredential("AKIA1/20260828/us-east-1/s3/aws4_request")).toEqual({
      accessKeyId: "AKIA1",
      dateStamp: "20260828",
      region: "us-east-1",
      service: "s3",
    });
  });

  test("rejects malformed credentials", () => {
    expect(parsePostCredential("AKIA1/20260828/us-east-1/s3")).toBeNull();
    expect(parsePostCredential("AKIA1/20260828/us-east-1/s3/wrong")).toBeNull();
    expect(parsePostCredential("//us-east-1/s3/aws4_request")).toBeNull();
  });

  test("verifies a signature over the base64 policy", () => {
    const secret = "topsecret";
    const credential = {
      accessKeyId: "AKIA1",
      dateStamp: "20260828",
      region: "us-east-1",
      service: "s3",
    };
    const policyBase64 = encodePolicy({ expiration: FUTURE, conditions: [] });
    const key = deriveSigningKey(secret, credential.dateStamp, credential.region, "s3");
    const signature = computeSignature(key, policyBase64);

    expect(
      verifyPostSignature({ secretAccessKey: secret, credential, policyBase64, signature }),
    ).toBe(true);
    expect(
      verifyPostSignature({
        secretAccessKey: "wrong",
        credential,
        policyBase64,
        signature,
      }),
    ).toBe(false);
    // A different policy with the same signature must not verify.
    expect(
      verifyPostSignature({
        secretAccessKey: secret,
        credential,
        policyBase64: encodePolicy({ expiration: FUTURE, conditions: [{ bucket: "x" }] }),
        signature,
      }),
    ).toBe(false);
  });

  test("rejects a signature that is not 64 hex characters", () => {
    expect(
      verifyPostSignature({
        secretAccessKey: "s",
        credential: {
          accessKeyId: "A",
          dateStamp: "20260828",
          region: "us-east-1",
          service: "s3",
        },
        policyBase64: "x",
        signature: "short",
      }),
    ).toBe(false);
  });

  test("exposes the algorithm label clients must send", () => {
    expect(POST_ALGORITHM).toBe("AWS4-HMAC-SHA256");
  });
});
