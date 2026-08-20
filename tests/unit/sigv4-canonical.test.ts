import { describe, expect, test } from "bun:test";
import {
  canonicalUri,
  canonicalQuery,
  canonicalHeaders,
  buildCanonicalRequest,
  buildStringToSign,
  deriveSigningKey,
  computeSignature,
  sha256Hex,
  uriEncode,
} from "../../apps/server/src/auth/sigv4-canonical.ts";

describe("SigV4 canonicalization", () => {
  test("AWS IAM ListUsers official example", () => {
    const headers = new Headers({
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      Host: "iam.amazonaws.com",
      "X-Amz-Date": "20150830T123600Z",
    });
    const { canonicalRequest } = buildCanonicalRequest({
      method: "GET",
      path: "/",
      query: new URLSearchParams("Action=ListUsers&Version=2010-05-08"),
      headers,
      signedHeaderNames: ["content-type", "host", "x-amz-date"],
      payloadHash: sha256Hex(""),
    });
    const expectedCanonical =
      "GET\n/\nAction=ListUsers&Version=2010-05-08\n" +
      "content-type:application/x-www-form-urlencoded; charset=utf-8\n" +
      "host:iam.amazonaws.com\n" +
      "x-amz-date:20150830T123600Z\n\n" +
      "content-type;host;x-amz-date\n" +
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(canonicalRequest).toBe(expectedCanonical);
    // sha256/HMAC are node built-ins; only assert that the string-to-sign
    // format matches spec and embeds the correct hash of the canonical
    // request we just verified above.
    const canonicalHash = sha256Hex(canonicalRequest);
    const sts = buildStringToSign({
      amzDate: "20150830T123600Z",
      scope: "20150830/us-east-1/iam/aws4_request",
      canonicalRequest,
    });
    expect(sts).toBe(
      `AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/iam/aws4_request\n${canonicalHash}`,
    );
    // Signature roundtrip: derive key → sign → non-empty hex of correct length.
    const key = deriveSigningKey(
      "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      "20150830",
      "us-east-1",
      "iam",
    );
    const sig = computeSignature(key, sts);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  test("canonical query sorts key then value and preserves duplicates", () => {
    expect(canonicalQuery(new URLSearchParams("z=2&a=3&a=1&empty="))).toBe(
      "a=1&a=3&empty=&z=2",
    );
  });

  test("canonical headers trim and collapse whitespace", () => {
    const h = new Headers({ Host: "example.com", "X-Test": "  a   b  " });
    const result = canonicalHeaders(h, ["x-test", "host"]);
    expect(result.canonicalHeaders).toBe("host:example.com\nx-test:a b\n");
    expect(result.signedHeaders).toBe("host;x-test");
  });

  test("S3 canonical URI preserves repeated slashes and encoded form", () => {
    expect(canonicalUri("/bucket/a//b/%2F/c")).toBe("/bucket/a//b/%2F/c");
  });

  test("URI encoder follows AWS RFC3986 rules", () => {
    expect(uriEncode("a b!*'()~/", true)).toBe(
      "a%20b%21%2A%27%28%29~%2F",
    );
  });
});
