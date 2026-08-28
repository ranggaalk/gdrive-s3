import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  applySseResponseHeaders,
  assertCustomerKeyMatches,
  parseSseCopySource,
  parseSseRequest,
} from "../../apps/server/src/s3/sse.ts";
import { S3Error } from "../../apps/server/src/s3/errors.ts";

const CUSTOMER_KEY = Buffer.alloc(32, 4);
const CUSTOMER_KEY_B64 = CUSTOMER_KEY.toString("base64");
const CUSTOMER_KEY_MD5 = createHash("md5").update(CUSTOMER_KEY).digest("base64");

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe("parseSseRequest", () => {
  test("no headers means no encryption requested", () => {
    expect(parseSseRequest(headers({}))).toEqual({ kind: "none" });
  });

  test("AES256 selects SSE-S3", () => {
    expect(parseSseRequest(headers({ "x-amz-server-side-encryption": "AES256" }))).toEqual({
      kind: "sse-s3",
    });
  });

  test("aws:kms selects SSE-KMS, carrying the key id and context", () => {
    expect(
      parseSseRequest(
        headers({
          "x-amz-server-side-encryption": "aws:kms",
          "x-amz-server-side-encryption-aws-kms-key-id": "kms_abc",
          "x-amz-server-side-encryption-context": "eyJhIjoiYiJ9",
        }),
      ),
    ).toEqual({ kind: "sse-kms", keyId: "kms_abc", context: "eyJhIjoiYiJ9" });
  });

  test("aws:kms without a key id is allowed, leaving the default to the caller", () => {
    expect(parseSseRequest(headers({ "x-amz-server-side-encryption": "aws:kms" }))).toEqual({
      kind: "sse-kms",
      keyId: null,
      context: null,
    });
  });

  test("an unknown algorithm is rejected", () => {
    expect(() => parseSseRequest(headers({ "x-amz-server-side-encryption": "rot13" }))).toThrow(
      S3Error,
    );
  });

  test("SSE-C is parsed when the key and MD5 agree", () => {
    const parsed = parseSseRequest(
      headers({
        "x-amz-server-side-encryption-customer-algorithm": "AES256",
        "x-amz-server-side-encryption-customer-key": CUSTOMER_KEY_B64,
        "x-amz-server-side-encryption-customer-key-md5": CUSTOMER_KEY_MD5,
      }),
    );
    expect(parsed.kind).toBe("sse-c");
    if (parsed.kind !== "sse-c") throw new Error("unreachable");
    expect(parsed.key.equals(CUSTOMER_KEY)).toBe(true);
    expect(parsed.keyMd5).toBe(CUSTOMER_KEY_MD5);
  });

  test("an SSE-C key whose MD5 does not match is rejected", () => {
    expect(() =>
      parseSseRequest(
        headers({
          "x-amz-server-side-encryption-customer-algorithm": "AES256",
          "x-amz-server-side-encryption-customer-key": CUSTOMER_KEY_B64,
          "x-amz-server-side-encryption-customer-key-md5": createHash("md5")
            .update(Buffer.alloc(32, 9))
            .digest("base64"),
        }),
      ),
    ).toThrow(S3Error);
  });

  test("an SSE-C key of the wrong length is rejected", () => {
    const short = Buffer.alloc(16, 4);
    expect(() =>
      parseSseRequest(
        headers({
          "x-amz-server-side-encryption-customer-algorithm": "AES256",
          "x-amz-server-side-encryption-customer-key": short.toString("base64"),
          "x-amz-server-side-encryption-customer-key-md5": createHash("md5")
            .update(short)
            .digest("base64"),
        }),
      ),
    ).toThrow(S3Error);
  });

  test("SSE-C missing its MD5 is rejected", () => {
    expect(() =>
      parseSseRequest(
        headers({
          "x-amz-server-side-encryption-customer-algorithm": "AES256",
          "x-amz-server-side-encryption-customer-key": CUSTOMER_KEY_B64,
        }),
      ),
    ).toThrow(S3Error);
  });

  test("a non-AES256 customer algorithm is rejected", () => {
    expect(() =>
      parseSseRequest(
        headers({
          "x-amz-server-side-encryption-customer-algorithm": "AES128",
          "x-amz-server-side-encryption-customer-key": CUSTOMER_KEY_B64,
          "x-amz-server-side-encryption-customer-key-md5": CUSTOMER_KEY_MD5,
        }),
      ),
    ).toThrow(S3Error);
  });

  test("combining SSE-C with server-managed encryption is refused", () => {
    expect(() =>
      parseSseRequest(
        headers({
          "x-amz-server-side-encryption": "AES256",
          "x-amz-server-side-encryption-customer-algorithm": "AES256",
          "x-amz-server-side-encryption-customer-key": CUSTOMER_KEY_B64,
          "x-amz-server-side-encryption-customer-key-md5": CUSTOMER_KEY_MD5,
        }),
      ),
    ).toThrow(S3Error);
  });
});

describe("parseSseCopySource", () => {
  test("returns null when the source needs no key", () => {
    expect(parseSseCopySource(headers({}))).toBeNull();
  });

  test("parses the copy-source customer key", () => {
    const parsed = parseSseCopySource(
      headers({
        "x-amz-copy-source-server-side-encryption-customer-algorithm": "AES256",
        "x-amz-copy-source-server-side-encryption-customer-key": CUSTOMER_KEY_B64,
        "x-amz-copy-source-server-side-encryption-customer-key-md5": CUSTOMER_KEY_MD5,
      }),
    );
    expect(parsed?.key.equals(CUSTOMER_KEY)).toBe(true);
  });
});

describe("applySseResponseHeaders", () => {
  test("adds nothing for an unencrypted object", () => {
    const out = new Headers();
    applySseResponseHeaders(out, null);
    expect([...out.keys()]).toEqual([]);
  });

  test("echoes the SSE-S3 algorithm", () => {
    const out = new Headers();
    applySseResponseHeaders(out, {
      sse_algorithm: "AES256",
      kms_key_id: null,
      customer_key_md5: null,
    });
    expect(out.get("x-amz-server-side-encryption")).toBe("AES256");
    expect(out.has("x-amz-server-side-encryption-aws-kms-key-id")).toBe(false);
  });

  test("echoes the KMS key id", () => {
    const out = new Headers();
    applySseResponseHeaders(out, {
      sse_algorithm: "aws:kms",
      kms_key_id: "kms_abc",
      customer_key_md5: null,
    });
    expect(out.get("x-amz-server-side-encryption")).toBe("aws:kms");
    expect(out.get("x-amz-server-side-encryption-aws-kms-key-id")).toBe("kms_abc");
  });

  test("SSE-C echoes the key MD5 and never the algorithm header", () => {
    const out = new Headers();
    applySseResponseHeaders(out, {
      sse_algorithm: "AES256",
      kms_key_id: null,
      customer_key_md5: CUSTOMER_KEY_MD5,
    });
    expect(out.get("x-amz-server-side-encryption-customer-key-md5")).toBe(CUSTOMER_KEY_MD5);
    expect(out.has("x-amz-server-side-encryption")).toBe(false);
  });
});

describe("assertCustomerKeyMatches", () => {
  test("passes when neither side involves SSE-C", () => {
    expect(() => assertCustomerKeyMatches(null, null)).not.toThrow();
  });

  test("passes when the presented key matches", () => {
    expect(() =>
      assertCustomerKeyMatches({ keyMd5: CUSTOMER_KEY_MD5 }, CUSTOMER_KEY_MD5),
    ).not.toThrow();
  });

  test("rejects a missing key for an SSE-C object", () => {
    expect(() => assertCustomerKeyMatches(null, CUSTOMER_KEY_MD5)).toThrow(S3Error);
  });

  test("rejects the wrong key rather than returning garbage", () => {
    expect(() => assertCustomerKeyMatches({ keyMd5: "someothermd5==" }, CUSTOMER_KEY_MD5)).toThrow(
      S3Error,
    );
  });

  test("rejects a key presented for an object that has none", () => {
    expect(() => assertCustomerKeyMatches({ keyMd5: CUSTOMER_KEY_MD5 }, null)).toThrow(S3Error);
  });
});
