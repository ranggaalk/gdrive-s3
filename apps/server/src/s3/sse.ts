// Server-side encryption request headers.
//
// Three schemes, distinguished by which headers arrive:
//   SSE-S3  (`x-amz-server-side-encryption: AES256`) — the gateway holds the key.
//   SSE-KMS (`...: aws:kms` plus an optional key id) — wrapped under a CMK.
//   SSE-C   (`x-amz-server-side-encryption-customer-*`) — the caller supplies
//           the key on every request and it is never stored.
//
// Kept free of I/O so it can be unit-tested on its own.

import { createHash } from "node:crypto";
import { S3Error } from "./errors.ts";
import { DATA_KEY_BYTES } from "../security/object-crypto.ts";

export const SSE_HEADER = "x-amz-server-side-encryption";
export const SSE_KMS_KEY_ID_HEADER = "x-amz-server-side-encryption-aws-kms-key-id";
export const SSE_CONTEXT_HEADER = "x-amz-server-side-encryption-context";
export const SSE_C_ALGORITHM_HEADER = "x-amz-server-side-encryption-customer-algorithm";
export const SSE_C_KEY_HEADER = "x-amz-server-side-encryption-customer-key";
export const SSE_C_KEY_MD5_HEADER = "x-amz-server-side-encryption-customer-key-md5";

/** Copy-source variants, for reading an encrypted object as a copy source. */
export const SSE_C_SOURCE_ALGORITHM_HEADER =
  "x-amz-copy-source-server-side-encryption-customer-algorithm";
export const SSE_C_SOURCE_KEY_HEADER =
  "x-amz-copy-source-server-side-encryption-customer-key";
export const SSE_C_SOURCE_KEY_MD5_HEADER =
  "x-amz-copy-source-server-side-encryption-customer-key-md5";

export type SseRequest =
  | { kind: "none" }
  | { kind: "sse-s3" }
  | { kind: "sse-kms"; keyId: string | null; context: string | null }
  | { kind: "sse-c"; key: Buffer; keyMd5: string };

/** The customer key and its MD5, validated against each other. */
function parseCustomerKey(
  headers: Headers,
  names: { algorithm: string; key: string; md5: string },
): { key: Buffer; keyMd5: string } {
  const algorithm = headers.get(names.algorithm);
  if (algorithm !== "AES256") {
    throw new S3Error("InvalidArgument", { ArgumentName: names.algorithm });
  }
  const rawKey = headers.get(names.key);
  const rawMd5 = headers.get(names.md5);
  if (!rawKey || !rawMd5) {
    throw new S3Error("InvalidRequest", {
      Reason: "SSE-C requires both the customer key and its MD5.",
    });
  }

  let key: Buffer;
  try {
    key = Buffer.from(rawKey, "base64");
  } catch {
    throw new S3Error("InvalidArgument", { ArgumentName: names.key });
  }
  if (key.length !== DATA_KEY_BYTES) {
    throw new S3Error("InvalidArgument", { ArgumentName: names.key });
  }

  // The MD5 is what lets a wrong key be rejected outright instead of silently
  // decrypting to garbage.
  const actual = createHash("md5").update(key).digest("base64");
  if (actual !== rawMd5) {
    throw new S3Error("InvalidArgument", { ArgumentName: names.md5 });
  }
  return { key, keyMd5: actual };
}

/** What the request is asking for, before any bucket default is applied. */
export function parseSseRequest(headers: Headers): SseRequest {
  const hasCustomer = headers.has(SSE_C_ALGORITHM_HEADER);
  const algorithm = headers.get(SSE_HEADER);

  if (hasCustomer) {
    // The two are mutually exclusive: one says the gateway holds the key, the
    // other says the caller does.
    if (algorithm) {
      throw new S3Error("InvalidRequest", {
        Reason: "SSE-C cannot be combined with server-managed encryption.",
      });
    }
    const { key, keyMd5 } = parseCustomerKey(headers, {
      algorithm: SSE_C_ALGORITHM_HEADER,
      key: SSE_C_KEY_HEADER,
      md5: SSE_C_KEY_MD5_HEADER,
    });
    return { kind: "sse-c", key, keyMd5 };
  }

  if (algorithm === null) return { kind: "none" };
  if (algorithm === "AES256") return { kind: "sse-s3" };
  if (algorithm === "aws:kms") {
    return {
      kind: "sse-kms",
      keyId: headers.get(SSE_KMS_KEY_ID_HEADER),
      context: headers.get(SSE_CONTEXT_HEADER),
    };
  }
  throw new S3Error("InvalidArgument", { ArgumentName: SSE_HEADER });
}

/** SSE-C key for reading a copy source, when the source is SSE-C encrypted. */
export function parseSseCopySource(headers: Headers): { key: Buffer; keyMd5: string } | null {
  if (!headers.has(SSE_C_SOURCE_ALGORITHM_HEADER)) return null;
  return parseCustomerKey(headers, {
    algorithm: SSE_C_SOURCE_ALGORITHM_HEADER,
    key: SSE_C_SOURCE_KEY_HEADER,
    md5: SSE_C_SOURCE_KEY_MD5_HEADER,
  });
}

/** Echo the encryption headers S3 returns on a write or read. */
export function applySseResponseHeaders(
  headers: Headers,
  encryption: {
    sse_algorithm: string;
    kms_key_id: string | null;
    customer_key_md5: string | null;
  } | null,
): void {
  if (!encryption) return;
  if (encryption.customer_key_md5) {
    headers.set(SSE_C_ALGORITHM_HEADER, "AES256");
    headers.set(SSE_C_KEY_MD5_HEADER, encryption.customer_key_md5);
    return;
  }
  headers.set(SSE_HEADER, encryption.sse_algorithm);
  if (encryption.kms_key_id) {
    headers.set(SSE_KMS_KEY_ID_HEADER, encryption.kms_key_id);
  }
}

/**
 * Verify the caller presented the same SSE-C key the object was written with.
 * Without this a mismatched key would decrypt to garbage and look like data
 * corruption rather than an authentication failure.
 */
export function assertCustomerKeyMatches(
  provided: { keyMd5: string } | null,
  storedMd5: string | null,
): void {
  if (storedMd5 === null) {
    // Object is not SSE-C. A key sent anyway is a client error, not a silent
    // no-op, because the caller clearly expects different bytes back.
    if (provided) {
      throw new S3Error("InvalidRequest", {
        Reason: "The object was not encrypted with a customer-provided key.",
      });
    }
    return;
  }
  if (!provided) {
    throw new S3Error("InvalidRequest", {
      Reason: "The object requires a customer-provided encryption key.",
    });
  }
  if (provided.keyMd5 !== storedMd5) throw new S3Error("AccessDenied");
}
