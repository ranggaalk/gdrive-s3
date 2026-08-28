// S3 CopyObject. Streams source bytes through DriveStorage into a new staging
// file, then atomically promotes the target mapping.
//
// Source and target may belong to different owners. Authorization for both
// ends runs through AuthorizationService, while the bytes are read with the
// source owner's Drive token and written with the target owner's — the two
// identities are deliberately not the same thing.

import { requireUser, type S3RequestContext } from "../context.ts";
import { authorizeBucket, verifyDriveAccess } from "../authorize.ts";
import { openCopySourceStream, resolveCopySource } from "../copy-source.ts";
import { S3Error } from "../errors.ts";
import { validateObjectKey } from "../key.ts";
import { parseObjectMetadata } from "../metadata.ts";
import { newVersionId } from "../../db/repositories/object-versions.ts";
import { EncryptionService } from "../../services/encryption-service.ts";
import { streamingUpload } from "../../drive/upload-streaming.ts";
import { quoteEtag } from "../etag.ts";
import { parseSseRequest, applySseResponseHeaders } from "../sse.ts";
import { parseLockHeaders, resolveDefaultRetention } from "../object-lock.ts";
import { tag, xmlDocument, xmlResponse } from "../xml.ts";

export async function copyObject(
  ctx: S3RequestContext,
  targetBucketName: string,
  targetKey: string,
): Promise<Response> {
  const userId = requireUser(ctx);
  validateObjectKey(targetKey, true);

  const source = resolveCopySource(ctx, { allowRange: false });
  const targetAuth = authorizeBucket(ctx, targetBucketName, "s3:PutObject", targetKey);
  const targetBucket = targetAuth.bucket;

  // Each side is checked against the account that will actually touch its
  // Drive, which for a cross-user copy are two different accounts.
  await verifyDriveAccess(ctx, targetAuth, true);
  try {
    await ctx.app.bucketAccess.verifyActorAccess(
      source.driveActorUserId,
      source.bucket,
      false,
      ctx.signal ?? undefined,
    );
  } catch {
    throw new S3Error("AccessDenied");
  }

  const directive = (ctx.headers.get("x-amz-metadata-directive") ?? "COPY").toUpperCase();
  if (directive !== "COPY" && directive !== "REPLACE") {
    throw new S3Error("InvalidArgument", { ArgumentName: "x-amz-metadata-directive" });
  }
  const replacement = directive === "REPLACE" ? parseObjectMetadata(ctx.headers) : null;
  const metadata = replacement
    ? replacement.userMetadata
    : parseJsonMetadata(source.object.metadata_json);
  const contentType = replacement?.contentType ?? source.object.content_type;

  // The target is encrypted according to its own bucket's rules, not the
  // source's — a copy out of an encrypted bucket into a plain one is a
  // legitimate way to decrypt, and vice versa.
  const encryption = new EncryptionService(ctx.app).planFor({
    ownerUserId: targetBucket.user_id,
    bucket: targetBucket,
    request: parseSseRequest(ctx.headers),
  });

  const requestedLock = parseLockHeaders(ctx.headers);
  const defaultRetention = requestedLock.mode
    ? null
    : resolveDefaultRetention(targetBucket.object_lock_default_json);
  const lock = targetBucket.object_lock_enabled
    ? {
        mode: requestedLock.mode ?? defaultRetention?.mode ?? null,
        retainUntil: requestedLock.retainUntil ?? defaultRetention?.retainUntil ?? null,
        legalHold: requestedLock.legalHold,
      }
    : null;

  const versionId = targetBucket.versioning === "Enabled" ? newVersionId() : "null";
  const previous = ctx.app.repos.objects.findByKey(targetBucket.id, targetKey);
  const staging = ctx.app.repos.objectStaging.start({
    requestId: ctx.requestId,
    userId: targetBucket.user_id,
    bucketId: targetBucket.id,
    objectKey: targetKey,
    contentType,
    metadata,
    cacheControl: replacement?.cacheControl ?? source.object.cache_control,
    contentDisposition: replacement?.contentDisposition ?? source.object.content_disposition,
    contentEncoding: replacement?.contentEncoding ?? source.object.content_encoding,
    contentLanguage: replacement?.contentLanguage ?? source.object.content_language,
    expiresAt: replacement?.expiresAt ?? source.object.expires_at,
    acl: source.object.acl,
    lock,
    sse: encryption
      ? {
          algorithm: encryption.algorithm,
          kmsKeyId: encryption.kmsKeyId,
          kmsKeyVersion: encryption.kmsKeyVersion,
          wrappedDataKey: encryption.wrappedDataKey,
          iv: encryption.iv.toString("base64"),
          customerKeyMd5: encryption.customerKeyMd5,
        }
      : null,
    oldDriveFileId: previous?.drive_file_id ?? null,
    driveTargetId: targetBucket.drive_target_id,
  });

  let uploadedId: string | null = null;
  // The upload slot belongs to the account doing the writing.
  const slot = await ctx.app.driveLimits.upload(targetBucket.user_id, ctx.signal ?? undefined);
  try {
    const body = await openCopySourceStream(ctx, source);
    const result = await streamingUpload({
      storage: ctx.app.driveStorage,
      userId: targetBucket.user_id,
      bucketId: targetBucket.id,
      bucketFolderId: targetBucket.drive_folder_id,
      objectId: staging.object_id,
      objectKey: targetKey,
      mimeType: contentType,
      body,
      contentLength: source.length,
      maxBytes: ctx.app.config.maxSinglePutBytes,
      resumableThreshold: ctx.app.config.driveResumableThresholdBytes,
      chunkSize: ctx.app.config.driveUploadChunkBytes,
      target: ctx.app.bucketAccess.operationTarget(targetBucket),
      signal: ctx.signal ?? undefined,
      ...(encryption
        ? { cipher: new EncryptionService(ctx.app).cipherFor(encryption) }
        : {}),
    });
    uploadedId = result.uploaded.driveFileId;
    ctx.app.repos.objectStaging.markUploaded({
      id: staging.id,
      driveFileId: uploadedId,
      sizeBytes: result.size,
      etag: result.md5Hex,
      checksumSha256: result.sha256Hex,
    });
    const committed = ctx.app.repos.objects.commitStagedObject(staging.id, {
      versioning: targetBucket.versioning,
      versionId,
    });
    if (
      !committed.archivedPrevious &&
      committed.previous &&
      committed.previous.drive_file_id !== uploadedId
    ) {
      await deleteOldTarget(
        ctx,
        committed.previous.drive_file_id,
        targetBucket.user_id,
        ctx.app.bucketAccess.operationTarget(targetBucket),
      );
    }
    ctx.app.repos.audit.record({
      userId,
      credentialId: ctx.credentialId,
      action: "s3.CopyObject",
      bucketName: targetBucketName,
      bucketId: targetBucket.id,
      objectKey: targetKey,
      statusCode: 200,
      bytesIn: result.size,
      requestId: ctx.requestId,
      detail: {
        sourceBucket: source.bucketName,
        directive,
        crossUser: source.bucket.user_id !== targetBucket.user_id,
      },
    });

    const object = committed.current;
    const headers = new Headers({
      ETag: quoteEtag(object.etag),
      "x-amz-request-id": ctx.requestId,
    });
    if (encryption) {
      applySseResponseHeaders(headers, {
        sse_algorithm: encryption.algorithm,
        kms_key_id: encryption.kmsKeyId,
        customer_key_md5: encryption.customerKeyMd5,
      });
    }
    if (versionId !== "null") headers.set("x-amz-version-id", versionId);
    if (source.object.version_id !== "null") {
      headers.set("x-amz-copy-source-version-id", source.object.version_id);
    }

    const body2 = xmlDocument(
      "CopyObjectResult",
      tag("LastModified", object.last_modified_at) + tag("ETag", quoteEtag(object.etag)),
    );
    return xmlResponse(body2, 200, Object.fromEntries(headers));
  } catch (error) {
    ctx.app.repos.objectStaging.markFailed(
      staging.id,
      error instanceof Error ? error.message : "copy failed",
    );
    if (uploadedId) {
      ctx.app.repos.pendingCleanup.enqueue({
        userId: targetBucket.user_id,
        resourceType: "drive_file",
        resourceId: uploadedId,
        reason: "failed_copy_object",
        driveTargetId: targetBucket.drive_target_id,
      });
    }
    throw error;
  } finally {
    slot.release();
  }
}

function parseJsonMetadata(raw: string): Record<string, string> {
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

async function deleteOldTarget(
  ctx: S3RequestContext,
  driveFileId: string,
  cleanupUserId: string,
  target: import("../../drive/storage.ts").DriveOperationTarget,
): Promise<void> {
  try {
    await ctx.app.driveStorage.deleteFile({
      // Deleting the superseded target file is the target owner's business.
      userId: cleanupUserId,
      driveFileId,
      mode: ctx.app.config.s3DeleteMode,
      target,
    });
    ctx.app.repos.pendingCleanup.completeResource(cleanupUserId, "drive_file", driveFileId);
  } catch {
    // The commit transaction already enqueued it.
  }
}
