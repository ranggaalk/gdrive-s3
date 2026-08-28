// Decides what encryption applies to a write, and reverses it on a read.
//
// The request headers, the bucket's default, and the CMK catalogue all feed in
// here so the operations never have to reason about the three SSE schemes
// individually.

import { createCipheriv, createDecipheriv } from "node:crypto";
import type { AppContext } from "../context.ts";
import type { AccessibleBucketRow } from "../db/repositories/buckets.ts";
import type { ObjectEncryptionRow } from "../db/repositories/object-encryption.ts";
import { S3Error } from "../s3/errors.ts";
import type { SseRequest } from "../s3/sse.ts";
import { assertCustomerKeyMatches } from "../s3/sse.ts";
import { counterBlockAt, generateDataKey, generateIv } from "../security/object-crypto.ts";
import { KmsKeyDisabledError, KmsKeyNotFoundError } from "../security/kms.ts";

/** Everything needed to encrypt one object body and record how. */
export interface EncryptionPlan {
  algorithm: "AES256" | "aws:kms";
  kmsKeyId: string | null;
  kmsKeyVersion: number | null;
  wrappedDataKey: string | null;
  customerKeyMd5: string | null;
  iv: Buffer;
  dataKey: Buffer;
}

const ALGORITHM = "aes-256-ctr";

export class EncryptionService {
  constructor(private readonly app: AppContext) {}

  /**
   * Work out what a write should be encrypted with, or null for plaintext.
   *
   * An explicit request header always wins; the bucket default only applies
   * when the request asked for nothing, which is what makes default
   * encryption a safety net rather than an override.
   */
  planFor(input: {
    ownerUserId: string;
    bucket: AccessibleBucketRow;
    request: SseRequest;
  }): EncryptionPlan | null {
    let request = input.request;

    if (request.kind === "none") {
      const fallback = input.bucket.default_sse_algorithm;
      if (!fallback) return null;
      request =
        fallback === "aws:kms"
          ? { kind: "sse-kms", keyId: input.bucket.default_kms_key_id, context: null }
          : { kind: "sse-s3" };
    }

    if (request.kind === "sse-c") {
      return {
        algorithm: "AES256",
        kmsKeyId: null,
        kmsKeyVersion: null,
        // Nothing to store: the caller keeps the key, which is the entire
        // point of SSE-C.
        wrappedDataKey: null,
        customerKeyMd5: request.keyMd5,
        iv: generateIv(),
        dataKey: request.key,
      };
    }

    if (request.kind === "sse-s3") {
      // SSE-S3 has no customer-visible key. The data key is wrapped under the
      // owner's implicit gateway key so it is still an envelope scheme rather
      // than a single master key protecting every object.
      const cmk = this.gatewayKeyFor(input.ownerUserId);
      const generated = this.app.kms.generateDataKey(input.ownerUserId, cmk.id);
      return {
        algorithm: "AES256",
        kmsKeyId: cmk.id,
        kmsKeyVersion: cmk.version,
        wrappedDataKey: generated.wrapped,
        customerKeyMd5: null,
        iv: generateIv(),
        dataKey: generated.plaintext,
      };
    }

    const keyRef = request.keyId ?? input.bucket.default_kms_key_id;
    if (!keyRef) {
      throw new S3Error("InvalidArgument", {
        ArgumentName: "x-amz-server-side-encryption-aws-kms-key-id",
        Reason: "No KMS key was named and the bucket has no default.",
      });
    }
    const cmk = this.resolveKey(input.ownerUserId, keyRef);
    try {
      const generated = this.app.kms.generateDataKey(input.ownerUserId, cmk.id);
      return {
        algorithm: "aws:kms",
        kmsKeyId: cmk.id,
        kmsKeyVersion: cmk.version,
        wrappedDataKey: generated.wrapped,
        customerKeyMd5: null,
        iv: generateIv(),
        dataKey: generated.plaintext,
      };
    } catch (error) {
      if (error instanceof KmsKeyDisabledError) {
        throw new S3Error("InvalidRequest", { Reason: "The KMS key is disabled." });
      }
      if (error instanceof KmsKeyNotFoundError) {
        throw new S3Error("InvalidArgument", {
          ArgumentName: "x-amz-server-side-encryption-aws-kms-key-id",
        });
      }
      throw error;
    }
  }

  /** A cipher for `streamingUpload`, encrypting from the first byte. */
  cipherFor(plan: EncryptionPlan): { update(c: Uint8Array): Uint8Array; final(): Uint8Array } {
    const cipher = createCipheriv(ALGORITHM, plan.dataKey, plan.iv);
    return {
      update: (chunk) => cipher.update(Buffer.from(chunk)),
      final: () => cipher.final(),
    };
  }

  /**
   * Recover the data key for a stored object and hand back a decrypting
   * transform seeked to `byteOffset`, so ranged reads stay cheap.
   */
  decryptorFor(input: {
    encryption: ObjectEncryptionRow;
    customerKey: { key: Buffer; keyMd5: string } | null;
    byteOffset: number;
  }): (source: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array> {
    const { encryption } = input;
    assertCustomerKeyMatches(input.customerKey, encryption.customer_key_md5);

    let dataKey: Buffer;
    if (encryption.customer_key_md5) {
      dataKey = input.customerKey!.key;
    } else {
      if (!encryption.kms_key_id || !encryption.wrapped_data_key) {
        throw new S3Error("InternalError");
      }
      try {
        dataKey = this.app.kms.decryptDataKey({
          kmsKeyId: encryption.kms_key_id,
          version: encryption.kms_key_version ?? 1,
          wrapped: encryption.wrapped_data_key,
        });
      } catch {
        // The key is gone or unreadable; the bytes are unrecoverable, which is
        // a server-side condition rather than a client mistake.
        throw new S3Error("InternalError");
      }
    }

    const iv = Buffer.from(encryption.iv, "base64");
    const offset = input.byteOffset;
    return (source) => {
      const decipher = createDecipheriv(ALGORITHM, dataKey, counterBlockAt(iv, offset));
      const partial = offset % 16;
      if (partial > 0) decipher.update(Buffer.alloc(partial));
      return transformThrough(source, decipher);
    };
  }

  /**
   * The implicit per-user key backing SSE-S3, created on first use. S3's
   * "aws/s3" managed key is the same idea: the customer never names it.
   */
  private gatewayKeyFor(userId: string) {
    const existing = this.app.repos.kmsKeys.findByAlias(userId, GATEWAY_KEY_ALIAS);
    if (existing) {
      if (existing.status !== "active") {
        throw new S3Error("InvalidRequest", {
          Reason: "The gateway encryption key is disabled.",
        });
      }
      return existing;
    }
    return this.app.kms.create({ userId, alias: GATEWAY_KEY_ALIAS });
  }

  /** Accept either a key id or an `alias/<name>` reference, as S3 does. */
  private resolveKey(userId: string, reference: string) {
    const alias = reference.startsWith("alias/") ? reference.slice("alias/".length) : null;
    const found = alias
      ? this.app.repos.kmsKeys.findByAlias(userId, alias)
      : this.app.repos.kmsKeys.findOwned(userId, reference);
    if (!found) {
      throw new S3Error("InvalidArgument", {
        ArgumentName: "x-amz-server-side-encryption-aws-kms-key-id",
      });
    }
    return found;
  }
}

export const GATEWAY_KEY_ALIAS = "aws/s3";

function transformThrough(
  source: ReadableStream<Uint8Array>,
  decipher: ReturnType<typeof createDecipheriv>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          const tail = decipher.final();
          if (tail.length > 0) controller.enqueue(new Uint8Array(tail));
          controller.close();
          return;
        }
        if (value && value.byteLength > 0) {
          const out = decipher.update(Buffer.from(value));
          if (out.length > 0) controller.enqueue(new Uint8Array(out));
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    },
  });
}
