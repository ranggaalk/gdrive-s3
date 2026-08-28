// Pure AWS Signature Version 4 canonicalization (AGENTS.md §11).
// Kept free of I/O so it can be unit-tested against the official AWS fixtures.

import { createHash, createHmac } from "node:crypto";

export const ALGORITHM = "AWS4-HMAC-SHA256";
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * RFC 3986 encoding used by SigV4. `encodeURIComponent` leaves ! ' ( ) *
 * unescaped and does not encode them; SigV4 requires them encoded. The path
 * variant additionally keeps "/" literal.
 */
export function uriEncode(input: string, encodeSlash = true): string {
  let out = "";
  for (const ch of Buffer.from(input, "utf8")) {
    const c = String.fromCharCode(ch);
    if (
      (ch >= 0x41 && ch <= 0x5a) || // A-Z
      (ch >= 0x61 && ch <= 0x7a) || // a-z
      (ch >= 0x30 && ch <= 0x39) || // 0-9
      c === "-" ||
      c === "_" ||
      c === "." ||
      c === "~"
    ) {
      out += c;
    } else if (c === "/") {
      out += encodeSlash ? "%2F" : "/";
    } else {
      out += "%" + ch.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

/** Canonical URI: each path segment URI-encoded once (slashes preserved). */
/**
 * Canonical URI for the S3 service. AWS docs are explicit that S3 does NOT
 * normalize the path and does NOT re-encode already-encoded segments: the
 * canonical URI is exactly the request path. Pass the pathname from
 * `URL.pathname`, which preserves the client's percent-encoded form.
 */
export function canonicalUri(path: string): string {
  if (path === "" || path === "/") return "/";
  return path;
}

/** Non-S3 canonical URI: decode once, then re-encode each segment. */
export function canonicalUriEncoded(path: string): string {
  if (path === "" || path === "/") return "/";
  return path
    .split("/")
    .map((seg) => uriEncode(decodeURIComponent(seg), true))
    .join("/");
}

/** Canonical query string: sorted, each key/value URI-encoded. */
export function canonicalQuery(query: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of query) pairs.push([uriEncode(k), uriEncode(v)]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

export interface CanonicalHeaderResult {
  canonicalHeaders: string;
  signedHeaders: string;
}

/**
 * Canonical headers for the given signed-header names. Values are trimmed and
 * inner whitespace collapsed; names lowercased and sorted.
 */
export function canonicalHeaders(
  headers: Headers,
  signedHeaderNames: string[],
): CanonicalHeaderResult {
  const names = signedHeaderNames.map((n) => n.toLowerCase()).sort();
  const lines = names.map((name) => {
    const raw = headers.get(name) ?? "";
    const value = raw.trim().replace(/\s+/g, " ");
    return `${name}:${value}\n`;
  });
  return { canonicalHeaders: lines.join(""), signedHeaders: names.join(";") };
}

export interface CanonicalRequestInput {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  signedHeaderNames: string[];
  payloadHash: string;
}

export function buildCanonicalRequest(input: CanonicalRequestInput): {
  canonicalRequest: string;
  signedHeaders: string;
} {
  const { canonicalHeaders: ch, signedHeaders } = canonicalHeaders(
    input.headers,
    input.signedHeaderNames,
  );
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(input.path),
    canonicalQuery(input.query),
    ch,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  return { canonicalRequest, signedHeaders };
}

export interface StringToSignInput {
  amzDate: string; // YYYYMMDDTHHMMSSZ
  scope: string; // date/region/service/aws4_request
  canonicalRequest: string;
  /** Defaults to SigV4. SigV4A passes its own AWS4-ECDSA-P256-SHA256 label;
   *  everything else about the string-to-sign is identical. */
  algorithm?: string;
}

export function buildStringToSign(input: StringToSignInput): string {
  return [
    input.algorithm ?? ALGORITHM,
    input.amzDate,
    input.scope,
    sha256Hex(input.canonicalRequest),
  ].join("\n");
}

export function deriveSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export function computeSignature(signingKey: Buffer, stringToSign: string): string {
  return createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
}
