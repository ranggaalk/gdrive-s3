// CompleteMultipartUpload: validate requested parts, stream-concatenate temp
// files to Drive resumable upload, then atomically promote through M5 staging.

import { createCipheriv } from "node:crypto";
import { rm, rmdir } from "node:fs/promises";
import { dirname } from "node:path";
import { requireUser, type S3RequestContext } from "../context.ts";
import { S3Error } from "../errors.ts";
import { withUploadLock } from "../../util/upload-lock.ts";
import { streamingUpload } from "../../drive/upload-streaming.ts";
import { multipartConcatStream, multipartEtag, validatePartFiles } from "../multipart-stream.ts";
import { quoteEtag } from "../etag.ts";
import { tag, xmlDocument, xmlResponse } from "../xml.ts";
import type { MultipartPartRow } from "../../db/repositories/multipart-parts.ts";
import { BodyTooLargeError, readBoundedText } from "../../util/body-size.ts";

interface RequestedPart {
  number: number;
  etag: string;
}

/**
 * Rebuild the cipher for an upload that asked for encryption. SSE-C uploads
 * cannot be completed this way: the customer key is never stored, and
 * CompleteMultipartUpload carries no key headers to supply it.
 */
function multipartCipher(
  ctx: S3RequestContext,
  upload: { sse_algorithm: string | null; sse_iv: string | null; sse_customer_key_md5: string | null; sse_kms_key_id: string | null; sse_kms_key_version: number | null; sse_wrapped_data_key: string | null },
) {
  if (!upload.sse_algorithm || !upload.sse_iv) return null;
  if (upload.sse_customer_key_md5) {
    throw new S3Error("NotImplemented", {
      Feature: "SSE-C multipart upload",
    });
  }
  if (!upload.sse_kms_key_id || !upload.sse_wrapped_data_key) {
    throw new S3Error("InternalError");
  }
  const dataKey = ctx.app.kms.decryptDataKey({
    kmsKeyId: upload.sse_kms_key_id,
    version: upload.sse_kms_key_version ?? 1,
    wrapped: upload.sse_wrapped_data_key,
  });
  const cipher = createCipheriv("aes-256-ctr", dataKey, Buffer.from(upload.sse_iv, "base64"));
  dataKey.fill(0);
  return {
    update: (chunk: Uint8Array) => cipher.update(Buffer.from(chunk)),
    final: () => cipher.final(),
  };
}

export async function completeMultipartUpload(
  ctx: S3RequestContext,
  bucketName: string,
  key: string,
): Promise<Response> {
  const uploadId = ctx.url.searchParams.get("uploadId") ?? "";
  return withUploadLock(
    ctx.app.uploadLocks,
    uploadId,
    async () => completeLocked(ctx, bucketName, key, uploadId),
    ctx.signal ?? undefined,
  );
}

async function completeLocked(
  ctx: S3RequestContext,
  bucketName: string,
  key: string,
  uploadId: string,
): Promise<Response> {
  let bucket;
  try {
    bucket = ctx.app.bucketAccess.findByName(requireUser(ctx), bucketName, "write");
  } catch {
    throw new S3Error("AccessDenied");
  }
  if (!bucket) throw new S3Error("NoSuchBucket", { BucketName: bucketName });
  try {
    await ctx.app.bucketAccess.verifyActorAccess(
      requireUser(ctx),
      bucket,
      true,
      ctx.signal ?? undefined,
    );
  } catch {
    throw new S3Error("AccessDenied");
  }
  const upload = ctx.app.repos.multipartUploads.byId(uploadId);
  if (
    !upload ||
    upload.status !== "open" ||
    upload.bucket_id !== bucket.id ||
    upload.object_key !== key
  ) {
    throw new S3Error("NoSuchUpload", { UploadId: uploadId });
  }

  let completeXml: string;
  try {
    completeXml = await readBoundedText(ctx.body, ctx.app.config.maxS3XmlBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new S3Error("EntityTooLarge");
    throw error;
  }
  const requested = parseCompleteXml(completeXml);
  const stored = ctx.app.repos.multipartParts.list(uploadId);
  const selected = validateRequestedParts(requested, stored, ctx.app.config.minMultipartPartBytes);
  await validatePartFiles(selected);
  const totalSize = selected.reduce((sum, part) => sum + part.size_bytes, 0);
  if (totalSize > ctx.app.config.maxMultipartObjectBytes) {
    throw new S3Error("EntityTooLarge");
  }
  if (!ctx.app.repos.multipartUploads.markCompleting(uploadId)) {
    throw new S3Error("NoSuchUpload", { UploadId: uploadId });
  }

  let metadata: Record<string, string> = {};
  try {
    metadata = JSON.parse(upload.metadata_json) as Record<string, string>;
  } catch {
    metadata = {};
  }
  const previous = ctx.app.repos.objects.findByKey(bucket.id, key);
  const staging = ctx.app.repos.objectStaging.start({
    requestId: ctx.requestId,
    userId: bucket.user_id,
    bucketId: bucket.id,
    objectKey: key,
    contentType: upload.content_type,
    metadata,
    cacheControl: null,
    contentDisposition: null,
    contentEncoding: null,
    contentLanguage: null,
    expiresAt: null,
    // Carried from the upload record so the object commits with the same key
    // the parts were assembled under.
    sse: upload.sse_algorithm && upload.sse_iv
      ? {
          algorithm: upload.sse_algorithm,
          kmsKeyId: upload.sse_kms_key_id,
          kmsKeyVersion: upload.sse_kms_key_version,
          wrappedDataKey: upload.sse_wrapped_data_key,
          iv: upload.sse_iv,
          customerKeyMd5: upload.sse_customer_key_md5,
        }
      : null,
    oldDriveFileId: previous?.drive_file_id ?? null,
    driveTargetId: bucket.drive_target_id,
  });

  const multiEtag = multipartEtag(selected);
  const uploadCipher = multipartCipher(ctx, upload);
  let uploadedFileId: string | null = null;
  const slot = await ctx.app.driveLimits.upload(requireUser(ctx), ctx.signal ?? undefined);
  try {
    const streamed = await streamingUpload({
      storage: ctx.app.driveStorage,
      userId: requireUser(ctx),
      bucketId: bucket.id,
      bucketFolderId: upload.drive_folder_id ?? bucket.drive_folder_id,
      objectId: staging.object_id,
      objectKey: key,
      mimeType: upload.content_type,
      body: multipartConcatStream(selected),
      contentLength: totalSize,
      maxBytes: ctx.app.config.maxMultipartObjectBytes,
      resumableThreshold: 0,
      chunkSize: ctx.app.config.driveUploadChunkBytes,
      target: ctx.app.bucketAccess.operationTarget(bucket),
      signal: ctx.signal ?? undefined,
      // Parts are stored as plaintext temp files; the whole object is
      // encrypted once here, at the point it becomes a single stream. That
      // keeps one contiguous CTR keystream over the assembled object, which
      // is what makes a later ranged read seekable.
      ...(uploadCipher ? { cipher: uploadCipher } : {}),
    });
    uploadedFileId = streamed.uploaded.driveFileId;
    ctx.app.repos.objectStaging.markUploaded({
      id: staging.id,
      driveFileId: streamed.uploaded.driveFileId,
      sizeBytes: streamed.size,
      etag: multiEtag,
      checksumSha256: streamed.sha256Hex,
    });
    const committed = ctx.app.repos.objects.commitStagedObject(staging.id);
    if (committed.previous && committed.previous.drive_file_id !== uploadedFileId) {
      await drainOldDriveFile(
        ctx,
        committed.previous.drive_file_id,
        bucket.user_id,
        ctx.app.bucketAccess.operationTarget(bucket),
      );
    }
    ctx.app.repos.multipartUploads.markCompleted(uploadId, selected.length);
    const tempFiles = ctx.app.repos.multipartParts.deleteAll(uploadId);
    await cleanupTempFiles(ctx, tempFiles);

    ctx.app.repos.audit.record({
      userId: requireUser(ctx),
      credentialId: ctx.credentialId,
      action: "s3.CompleteMultipartUpload",
      bucketName,
      bucketId: bucket.id,
      objectKey: key,
      statusCode: 200,
      bytesIn: totalSize,
      requestId: ctx.requestId,
      detail: { uploadId, partCount: selected.length },
    });
    const body = xmlDocument(
      "CompleteMultipartUploadResult",
      tag("Location", `${ctx.app.config.s3PublicEndpoint}/${bucketName}/${key}`) +
        tag("Bucket", bucketName) +
        tag("Key", key) +
        tag("ETag", quoteEtag(multiEtag)),
    );
    return xmlResponse(body, 200, {
      ETag: quoteEtag(multiEtag),
      "x-amz-request-id": ctx.requestId,
    });
  } catch (error) {
    ctx.app.repos.objectStaging.markFailed(
      staging.id,
      error instanceof Error ? error.message : "multipart complete failed",
    );
    ctx.app.repos.multipartUploads.markFailed(
      uploadId,
      error instanceof Error ? error.message : "multipart complete failed",
    );
    if (uploadedFileId) {
      ctx.app.repos.pendingCleanup.enqueue({
        userId: bucket.user_id,
        resourceType: "drive_file",
        resourceId: uploadedFileId,
        reason: "failed_multipart_complete",
        driveTargetId: bucket.drive_target_id,
      });
    }
    throw error;
  } finally {
    slot.release();
  }
}

function parseCompleteXml(xml: string): RequestedPart[] {
  const parts: RequestedPart[] = [];
  const blockRe = /<Part>([\s\S]*?)<\/Part>/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(xml)) !== null) {
    const number = /<PartNumber>(\d+)<\/PartNumber>/.exec(block[1] ?? "")?.[1];
    const etag = /<ETag>([^<]+)<\/ETag>/.exec(block[1] ?? "")?.[1];
    if (!number || !etag) throw new S3Error("InvalidPart");
    parts.push({
      number: Number(number),
      etag: unescapeXml(etag).replace(/^"|"$/g, ""),
    });
  }
  if (parts.length === 0) throw new S3Error("InvalidPart");
  return parts;
}

function validateRequestedParts(
  requested: RequestedPart[],
  stored: MultipartPartRow[],
  minPartBytes: number,
): MultipartPartRow[] {
  let previous = 0;
  const selected: MultipartPartRow[] = [];
  for (const req of requested) {
    if (req.number <= previous) throw new S3Error("InvalidPartOrder");
    previous = req.number;
    const found = stored.find((part) => part.part_number === req.number);
    if (!found || found.etag !== req.etag) throw new S3Error("InvalidPart");
    selected.push(found);
  }
  for (let i = 0; i < selected.length - 1; i++) {
    if (selected[i]!.size_bytes < minPartBytes) throw new S3Error("EntityTooSmall");
  }
  return selected;
}

async function cleanupTempFiles(ctx: S3RequestContext, parts: MultipartPartRow[]): Promise<void> {
  const dirs = new Set<string>();
  for (const part of parts) {
    try {
      await rm(part.temp_path, { force: true });
      dirs.add(dirname(part.temp_path));
    } catch {
      ctx.app.repos.pendingCleanup.enqueue({
        userId: requireUser(ctx),
        resourceType: "temp_file",
        resourceId: part.temp_path,
        reason: "multipart_complete_cleanup",
      });
    }
  }
  for (const dir of dirs) await rmdir(dir).catch(() => {});
}

async function drainOldDriveFile(
  ctx: S3RequestContext,
  driveFileId: string,
  cleanupUserId: string,
  target: import("../../drive/storage.ts").DriveOperationTarget,
): Promise<void> {
  try {
    await ctx.app.driveStorage.deleteFile({
      userId: requireUser(ctx),
      driveFileId,
      mode: ctx.app.config.s3DeleteMode,
      target,
    });
    ctx.app.repos.pendingCleanup.completeResource(cleanupUserId, "drive_file", driveFileId);
  } catch {
    // transaction already enqueued it; worker retries.
  }
}

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
