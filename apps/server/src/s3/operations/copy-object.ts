// S3 CopyObject. Streams source bytes through DriveStorage into a new staging
// file, then atomically promotes the target mapping (AGENTS.md M6).

import type { S3RequestContext } from "../context.ts";
import { S3Error } from "../errors.ts";
import { decodeS3Path, validateObjectKey } from "../key.ts";
import { parseObjectMetadata } from "../metadata.ts";
import { streamingUpload } from "../../drive/upload-streaming.ts";
import { quoteEtag } from "../etag.ts";
import { tag, xmlDocument, xmlResponse } from "../xml.ts";

export async function copyObject(
  ctx: S3RequestContext,
  targetBucketName: string,
  targetKey: string,
): Promise<Response> {
  validateObjectKey(targetKey, true);
  if (ctx.headers.has("x-amz-copy-source-range")) throw new S3Error("NotImplemented");
  const sourceHeader = ctx.headers.get("x-amz-copy-source");
  if (!sourceHeader) throw new S3Error("InvalidRequest");
  const { bucket: sourceBucketName, key: sourceKey } = decodeS3Path(
    sourceHeader.startsWith("/") ? sourceHeader : `/${sourceHeader}`,
  );
  if (!sourceBucketName || sourceKey === null) throw new S3Error("InvalidRequest");
  validateObjectKey(sourceKey, true);

  let sourceBucket;
  let targetBucket;
  try {
    sourceBucket = ctx.app.bucketAccess.findByName(ctx.userId, sourceBucketName, "read");
    targetBucket = ctx.app.bucketAccess.findByName(ctx.userId, targetBucketName, "write");
  } catch {
    throw new S3Error("AccessDenied");
  }
  if (!sourceBucket) throw new S3Error("NoSuchBucket", { BucketName: sourceBucketName });
  const source = ctx.app.repos.objects.findByKey(sourceBucket.id, sourceKey);
  if (!source) throw new S3Error("NoSuchKey", { Key: sourceKey });
  if (!targetBucket) throw new S3Error("NoSuchBucket", { BucketName: targetBucketName });
  try {
    await ctx.app.bucketAccess.verifyActorAccess(
      ctx.userId,
      sourceBucket,
      false,
      ctx.signal ?? undefined,
    );
    await ctx.app.bucketAccess.verifyActorAccess(
      ctx.userId,
      targetBucket,
      true,
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
  const metadata = replacement ? replacement.userMetadata : parseJsonMetadata(source.metadata_json);
  const contentType = replacement?.contentType ?? source.content_type;
  const previous = ctx.app.repos.objects.findByKey(targetBucket.id, targetKey);
  const staging = ctx.app.repos.objectStaging.start({
    requestId: ctx.requestId,
    userId: targetBucket.user_id,
    bucketId: targetBucket.id,
    objectKey: targetKey,
    contentType,
    metadata,
    cacheControl: replacement?.cacheControl ?? source.cache_control,
    contentDisposition: replacement?.contentDisposition ?? source.content_disposition,
    contentEncoding: replacement?.contentEncoding ?? source.content_encoding,
    contentLanguage: replacement?.contentLanguage ?? source.content_language,
    expiresAt: replacement?.expiresAt ?? source.expires_at,
    oldDriveFileId: previous?.drive_file_id ?? null,
    driveTargetId: targetBucket.drive_target_id,
  });

  let uploadedId: string | null = null;
  const slot = await ctx.app.driveLimits.upload(ctx.userId, ctx.signal ?? undefined);
  try {
    const sourceResponse = await ctx.app.driveStorage.downloadObject({
      userId: ctx.userId,
      driveFileId: source.drive_file_id,
      target: ctx.app.bucketAccess.operationTarget(sourceBucket),
      signal: ctx.signal ?? undefined,
    });
    if (!sourceResponse.ok || !sourceResponse.body) throw new S3Error("NoSuchKey", { Key: sourceKey });
    const result = await streamingUpload({
      storage: ctx.app.driveStorage,
      userId: ctx.userId,
      bucketId: targetBucket.id,
      bucketFolderId: targetBucket.drive_folder_id,
      objectId: staging.object_id,
      objectKey: targetKey,
      mimeType: contentType,
      body: sourceResponse.body,
      contentLength: source.size_bytes,
      maxBytes: ctx.app.config.maxSinglePutBytes,
      resumableThreshold: ctx.app.config.driveResumableThresholdBytes,
      chunkSize: ctx.app.config.driveUploadChunkBytes,
      target: ctx.app.bucketAccess.operationTarget(targetBucket),
      signal: ctx.signal ?? undefined,
    });
    uploadedId = result.uploaded.driveFileId;
    ctx.app.repos.objectStaging.markUploaded({
      id: staging.id,
      driveFileId: uploadedId,
      sizeBytes: result.size,
      etag: result.md5Hex,
      checksumSha256: result.sha256Hex,
    });
    const committed = ctx.app.repos.objects.commitStagedObject(staging.id);
    if (committed.previous && committed.previous.drive_file_id !== uploadedId) {
      await deleteOldTarget(
        ctx,
        committed.previous.drive_file_id,
        targetBucket.user_id,
        ctx.app.bucketAccess.operationTarget(targetBucket),
      );
    }
    ctx.app.repos.audit.record({
      userId: ctx.userId,
      credentialId: ctx.credentialId,
      action: "s3.CopyObject",
      bucketName: targetBucketName,
      bucketId: targetBucket.id,
      objectKey: targetKey,
      statusCode: 200,
      bytesIn: result.size,
      requestId: ctx.requestId,
      detail: { sourceBucket: sourceBucketName, directive },
    });
    const object = committed.current;
    const body = xmlDocument(
      "CopyObjectResult",
      tag("LastModified", object.last_modified_at) + tag("ETag", quoteEtag(object.etag)),
    );
    return xmlResponse(body, 200, {
      ETag: quoteEtag(object.etag),
      "x-amz-request-id": ctx.requestId,
    });
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
      userId: ctx.userId,
      driveFileId,
      mode: ctx.app.config.s3DeleteMode,
      target,
    });
    ctx.app.repos.pendingCleanup.completeResource(cleanupUserId, "drive_file", driveFileId);
  } catch {
    // commit transaction already enqueued it.
  }
}
