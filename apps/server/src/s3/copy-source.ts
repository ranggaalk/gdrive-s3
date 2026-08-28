// Resolving and reading a copy source, shared by CopyObject and
// UploadPartCopy.
//
// The interesting part is that a copy spans two buckets that may have
// different owners, which makes the two identities established in the ACL
// milestone matter concretely:
//
//   authorization — may *this caller* read the source and write the target?
//                   Decided by AuthorizationService, so a bucket policy or
//                   ACL grant is enough; the caller need not own either.
//   Drive identity — whose OAuth token actually moves the bytes? Always the
//                   owner of the bucket the bytes live in, because that is
//                   the only account whose Drive holds them.
//
// Conflating the two is what made cross-user copy impossible before: the
// caller's token was used to read a file sitting in someone else's Drive.

import type { AccessibleBucketRow } from "../db/repositories/buckets.ts";
import type { ObjectRow } from "../db/repositories/objects.ts";
import type { ObjectEncryptionRow } from "../db/repositories/object-encryption.ts";
import { EncryptionService } from "../services/encryption-service.ts";
import { authorizeBucket } from "./authorize.ts";
import { evaluateCopySourceConditions } from "./conditions.ts";
import type { S3RequestContext } from "./context.ts";
import { S3Error } from "./errors.ts";
import { decodeS3Path, validateObjectKey } from "./key.ts";
import { parseRange, type ResolvedRange } from "./range.ts";
import { assertCustomerKeyMatches, parseSseCopySource } from "./sse.ts";

export interface ResolvedCopySource {
  bucket: AccessibleBucketRow;
  object: ObjectRow;
  bucketName: string;
  key: string;
  /** Whose Drive credentials can actually read these bytes. */
  driveActorUserId: string;
  encryption: ObjectEncryptionRow | null;
  /** Present when `x-amz-copy-source-range` narrowed the copy. */
  range: ResolvedRange | null;
  /** Bytes the copy will move — the range length, or the whole object. */
  length: number;
}

/**
 * Parse `x-amz-copy-source`, authorize the read, and evaluate the copy
 * preconditions and range.
 *
 * `versionId` in the source is accepted so a specific version can be copied,
 * which is what makes versioning and copy compose.
 */
export function resolveCopySource(
  ctx: S3RequestContext,
  options: { allowRange: boolean },
): ResolvedCopySource {
  const rawHeader = ctx.headers.get("x-amz-copy-source");
  if (!rawHeader) throw new S3Error("InvalidRequest");

  // The source may carry ?versionId=…; strip it before decoding the path.
  const [pathPart, queryPart] = rawHeader.split("?", 2);
  const normalized = (pathPart ?? "").startsWith("/") ? pathPart! : `/${pathPart ?? ""}`;
  const { bucket: sourceBucketName, key: sourceKey } = decodeS3Path(normalized);
  if (!sourceBucketName || sourceKey === null || sourceKey === "") {
    throw new S3Error("InvalidRequest", { Reason: "Malformed x-amz-copy-source." });
  }
  validateObjectKey(sourceKey, true);
  const sourceVersionId = queryPart
    ? new URLSearchParams(queryPart).get("versionId")
    : null;

  // Authorization runs through the same path every other read does, so a
  // policy grant on someone else's bucket is honoured here too.
  const authorized = authorizeBucket(ctx, sourceBucketName, "s3:GetObject", sourceKey);
  const bucket = authorized.bucket;

  let object: ObjectRow;
  let encryption: ObjectEncryptionRow | null;

  if (sourceVersionId && authorized.object?.version_id !== sourceVersionId) {
    const archived = ctx.app.repos.objectVersions.find(bucket.id, sourceKey, sourceVersionId);
    if (!archived || archived.is_delete_marker === 1 || !archived.drive_file_id || !archived.etag) {
      throw new S3Error("NoSuchVersion", { VersionId: sourceVersionId });
    }
    object = {
      id: archived.id,
      bucket_id: archived.bucket_id,
      object_key: archived.object_key,
      drive_file_id: archived.drive_file_id,
      size_bytes: archived.size_bytes,
      content_type: archived.content_type,
      etag: archived.etag,
      checksum_sha256: archived.checksum_sha256,
      storage_class: archived.storage_class,
      status: "active",
      metadata_json: archived.metadata_json,
      cache_control: archived.cache_control,
      content_disposition: archived.content_disposition,
      content_encoding: archived.content_encoding,
      content_language: archived.content_language,
      expires_at: archived.expires_at,
      acl: archived.acl as ObjectRow["acl"],
      version_id: archived.version_id,
      lock_mode: archived.lock_mode,
      retain_until: archived.retain_until,
      legal_hold: archived.legal_hold,
      last_modified_at: archived.last_modified_at,
      created_at: archived.created_at,
      updated_at: archived.created_at,
    };
    encryption = archived.sse_algorithm && archived.sse_iv
      ? {
          object_id: archived.id,
          sse_algorithm: archived.sse_algorithm as "AES256" | "aws:kms",
          kms_key_id: archived.sse_kms_key_id,
          kms_key_version: archived.sse_kms_key_version,
          wrapped_data_key: archived.sse_wrapped_data_key,
          iv: archived.sse_iv,
          customer_key_md5: archived.sse_customer_key_md5,
          created_at: archived.created_at,
        }
      : null;
  } else {
    if (!authorized.object) throw new S3Error("NoSuchKey", { Key: sourceKey });
    object = authorized.object;
    encryption = ctx.app.repos.objectEncryption.find(object.id);
  }

  evaluateCopySourceConditions(ctx.headers, object);

  const rawRange = ctx.headers.get("x-amz-copy-source-range");
  if (rawRange && !options.allowRange) {
    // CopyObject has no ranged form in S3 — that is what UploadPartCopy is
    // for — so the header is refused rather than silently ignored.
    throw new S3Error("InvalidArgument", { ArgumentName: "x-amz-copy-source-range" });
  }
  const range = rawRange ? parseRange(rawRange, object.size_bytes) : null;

  return {
    bucket,
    object,
    bucketName: sourceBucketName,
    key: sourceKey,
    // The bytes live in the source bucket owner's Drive, so only that
    // account's token can fetch them — regardless of who is authorized.
    driveActorUserId: bucket.user_id,
    encryption,
    range,
    length: range ? range.length : object.size_bytes,
  };
}

/**
 * Open the source bytes, decrypted and range-limited, ready to be written
 * into the target.
 */
export async function openCopySourceStream(
  ctx: S3RequestContext,
  source: ResolvedCopySource,
): Promise<ReadableStream<Uint8Array>> {
  const customerKey = parseSseCopySource(ctx.headers);
  assertCustomerKeyMatches(customerKey, source.encryption?.customer_key_md5 ?? null);

  const upstream = await ctx.app.driveStorage.downloadObject({
    userId: source.driveActorUserId,
    driveFileId: source.object.drive_file_id,
    range: source.range?.headerValue,
    target: ctx.app.bucketAccess.operationTarget(source.bucket),
    signal: ctx.signal ?? undefined,
  });
  if (!upstream.ok || !upstream.body) {
    throw new S3Error("NoSuchKey", { Key: source.key });
  }

  if (!source.encryption) return upstream.body;

  // Decrypt on the way out, seeked to the range start so a ranged copy of an
  // encrypted object does not have to read from byte zero.
  const decrypt = new EncryptionService(ctx.app).decryptorFor({
    encryption: source.encryption,
    customerKey,
    byteOffset: source.range?.start ?? 0,
  });
  return decrypt(upstream.body);
}
