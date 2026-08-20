import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { xmlEscape, tag, xmlDocument } from "../../apps/server/src/s3/xml.ts";
import { md5Hex, quoteEtag, md5Passthrough } from "../../apps/server/src/s3/etag.ts";
import {
  encodeContinuationToken,
  decodeContinuationToken,
} from "../../apps/server/src/s3/pagination.ts";
import { decodeS3Path, validateObjectKey } from "../../apps/server/src/s3/key.ts";
import { decodeAwsChunkedBody } from "../../apps/server/src/s3/aws-chunked.ts";
import { parseS3PayloadMode } from "../../apps/server/src/auth/s3-payload.ts";
import { sha256Hex } from "../../apps/server/src/auth/sigv4-canonical.ts";

describe("S3 XML", () => {
  test("escapes all XML special characters", () => {
    expect(xmlEscape(`a&<b>"'`)).toBe("a&amp;&lt;b&gt;&quot;&apos;");
    expect(tag("Key", "a<&")).toBe("<Key>a&lt;&amp;</Key>");
  });

  test("document has declaration and S3 namespace", () => {
    const xml = xmlDocument("ListBucketResult", tag("Name", "x"));
    expect(xml).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('xmlns="http://s3.amazonaws.com/doc/2006-03-01/"');
  });
});

describe("ETag", () => {
  test("single-part MD5 matches known fixture", () => {
    expect(md5Hex("hello\n")).toBe("b1946ac92492d2347c6235b4d2611184");
    expect(quoteEtag("b1946ac92492d2347c6235b4d2611184")).toBe(
      '"b1946ac92492d2347c6235b4d2611184"',
    );
  });

  test("passthrough hashes without changing bytes", async () => {
    const src = new Response("stream me").body!;
    const { stream, digest } = md5Passthrough(src);
    expect(await new Response(stream).text()).toBe("stream me");
    const d = await digest;
    expect(d.hex).toBe(md5Hex("stream me"));
    expect(d.size).toBe(9);
    expect(d.sha256Hex).toHaveLength(64);
  });
});

describe("continuation token", () => {
  const secret = Buffer.alloc(32, 7);
  test("roundtrip", () => {
    const token = encodeContinuationToken({ b: "b1", a: "after", p: "pre", d: "/" }, secret);
    expect(decodeContinuationToken(token, secret)).toMatchObject({
      b: "b1",
      a: "after",
      p: "pre",
      d: "/",
    });
  });

  test("tamper rejection", () => {
    const token = encodeContinuationToken({ b: "b1", a: "after", p: "", d: "" }, secret);
    const changed = `x${token.slice(1)}`;
    expect(decodeContinuationToken(changed, secret)).toBeNull();
    expect(decodeContinuationToken(token, Buffer.alloc(32, 8))).toBeNull();
  });

  test("rejects expired and incomplete payloads", () => {
    const expired = encodeContinuationToken(
      { b: "b1", a: "after", p: "", d: "", ttlMs: -1 },
      secret,
    );
    expect(decodeContinuationToken(expired, secret)).toBeNull();

    const incompleteBody = Buffer.from(
      JSON.stringify({ b: "b1", a: "after", e: Date.now() + 60_000 }),
      "utf8",
    ).toString("base64url");
    const mac = createHmac("sha256", secret)
      .update(incompleteBody, "utf8")
      .digest("base64url");
    expect(decodeContinuationToken(`${incompleteBody}.${mac}`, secret)).toBeNull();
  });
});

describe("S3 streaming payload", () => {
  test("classifies supported and unsupported payload modes", () => {
    expect(parseS3PayloadMode("UNSIGNED-PAYLOAD")).toEqual({ kind: "unsigned" });
    expect(parseS3PayloadMode("a".repeat(64))).toEqual({
      kind: "digest",
      sha256Hex: "a".repeat(64),
    });
    expect(parseS3PayloadMode("STREAMING-AWS4-HMAC-SHA256-PAYLOAD")).toEqual({
      kind: "streaming-signed",
    });
    expect(parseS3PayloadMode("STREAMING-UNSIGNED-PAYLOAD-TRAILER").kind).toBe(
      "unsupported",
    );
  });

  test("decodes and verifies a chained aws-chunked body", async () => {
    const signingKey = Buffer.alloc(32, 9);
    const amzDate = "20260717T120000Z";
    const scope = "20260717/us-east-1/s3/aws4_request";
    const emptyHash = sha256Hex("");
    let previous = "0".repeat(64);
    const frame = (bytes: Uint8Array) => {
      const stringToSign =
        `AWS4-HMAC-SHA256-PAYLOAD\n${amzDate}\n${scope}\n${previous}\n` +
        `${emptyHash}\n${sha256Hex(bytes)}`;
      const signature = createHmac("sha256", signingKey)
        .update(stringToSign, "utf8")
        .digest("hex");
      previous = signature;
      return `${bytes.byteLength.toString(16)};chunk-signature=${signature}\r\n` +
        `${new TextDecoder().decode(bytes)}\r\n`;
    };
    const wire = frame(new TextEncoder().encode("hello")) + frame(new Uint8Array());
    const decoded = decodeAwsChunkedBody(
      new Response(wire).body!,
      { signingKey: Buffer.from(signingKey), seedSignature: "0".repeat(64), amzDate, scope },
      5,
    );
    expect(await new Response(decoded).text()).toBe("hello");
  });
});

describe("S3 key parsing", () => {
  test("decodes exactly once and preserves key path semantics", () => {
    expect(decodeS3Path("/bucket/a%252Fb//./c")).toEqual({
      bucket: "bucket",
      key: "a%2Fb//./c",
    });
  });

  test("rejects invalid percent encoding", () => {
    expect(() => decodeS3Path("/bucket/%ZZ")).toThrow();
  });

  test("enforces empty and 1024-byte key limits", () => {
    expect(() => validateObjectKey("")).toThrow();
    expect(() => validateObjectKey("a".repeat(1024))).not.toThrow();
    expect(() => validateObjectKey("é".repeat(513))).toThrow();
  });
});
