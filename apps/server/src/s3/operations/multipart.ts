// S3 multipart upload lifecycle (AGENTS.md §14). CreateMultipartUpload,
// UploadPart, ListParts, CompleteMultipartUpload, AbortMultipartUpload,
// ListMultipartUploads. Byte concatenation streams from temp files.

import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { requireUser, type S3RequestContext } from "../context.ts";
import { S3Error } from "../errors.ts";
import { parseObjectMetadata } from "../metadata.ts";
import { validateObjectKey } from "../key.ts";
import { newUploadId } from "../../util/ids.ts";
import { openAtomicPart } from "../../util/multipart-path.ts";
import { withUploadLock } from "../../util/upload-lock.ts";
import { quoteEtag } from "../etag.ts";
import { tag, xmlDocument, xmlEscape, xmlResponse } from "../xml.ts";
import { streamingUpload } from "../../drive/upload-streaming.ts";
import { multipartConcatStream, multipartEtag, validatePartFiles } from "../multipart-stream.ts";
import type { MultipartPartRow } from "../../db/repositories/multipart-parts.ts";
import { assertPayloadDigest, preparePayload } from "../payload-body.ts";

function requireBucket(
  ctx: S3RequestContext,
  bucketName: string,
  operation: "read" | "write" = "read",
) {
  try {
    const bucket = ctx.app.bucketAccess.findByName(requireUser(ctx), bucketName, operation);
    if (!bucket) throw new S3Error("NoSuchBucket", { BucketName: bucketName });
    return bucket;
  } catch (error) {
    if (error instanceof S3Error) throw error;
    throw new S3Error("AccessDenied");
  }
}

function requireUpload(ctx: S3RequestContext, uploadId: string) {
  const upload = ctx.app.repos.multipartUploads.byId(uploadId);
  if (!upload || upload.status !== "open") throw new S3Error("NoSuchUpload", { UploadId: uploadId });
  return upload;
}

export async function createMultipartUpload(
  ctx: S3RequestContext,
  bucketName: string,
  key: string,
): Promise<Response> {
  validateObjectKey(key, true);
  const bucket = requireBucket(ctx, bucketName, "write");
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
  const meta = parseObjectMetadata(ctx.headers);
  const id = newUploadId();
  const expiresAt = new Date(
    Date.now() + ctx.app.config.multipartTtlHours * 60 * 60 * 1000,
  ).toISOString();
  ctx.app.repos.multipartUploads.create({
    id,
    userId: bucket.user_id,
    bucketId: bucket.id,
    driveFolderId: bucket.drive_folder_id,
    objectKey: key,
    contentType: meta.contentType,
    metadata: meta.userMetadata,
    expiresAt,
    driveTargetId: bucket.drive_target_id,
  });
  ctx.app.repos.audit.record({
    userId: requireUser(ctx),
    credentialId: ctx.credentialId,
    action: "s3.CreateMultipartUpload",
    bucketName,
    bucketId: bucket.id,
    objectKey: key,
    statusCode: 200,
    requestId: ctx.requestId,
  });
  const body = xmlDocument(
    "InitiateMultipartUploadResult",
    tag("Bucket", bucketName) + tag("Key", key) + tag("UploadId", id),
  );
  return xmlResponse(body, 200, { "x-amz-request-id": ctx.requestId });
}

export async function uploadPart(
  ctx: S3RequestContext,
  bucketName: string,
  key: string,
): Promise<Response> {
  const bucket = requireBucket(ctx, bucketName, "write");
  const uploadId = ctx.url.searchParams.get("uploadId") ?? "";
  const partNumber = Number(ctx.url.searchParams.get("partNumber"));
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > ctx.app.config.maxParts) {
    throw new S3Error("InvalidArgument", { ArgumentName: "partNumber" });
  }
  const upload = requireUpload(ctx, uploadId);
  if (upload.bucket_id !== bucket.id || upload.object_key !== key) {
    throw new S3Error("InvalidRequest", { Reason: "Upload does not match bucket/key." });
  }
  const payload = preparePayload(ctx);

  const md5 = createHash("md5");
  const sha256 = createHash("sha256");
  const part = await openAtomicPart(
    ctx.app.config.multipartTempDir,
    uploadId,
    partNumber,
    ctx.app.config.maxParts,
  );
  let committed = false;
  let size = 0;
  try {
    const reader = payload.body.getReader();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > ctx.app.config.maxSinglePutBytes) throw new S3Error("EntityTooLarge");
      md5.update(value);
      sha256.update(value);
      await part.handle.write(value);
    }
    const md5Hex = md5.digest("hex");
    const sha256Hex = sha256.digest("hex");
    assertPayloadDigest(payload.mode, sha256Hex);
    const previous = ctx.app.repos.multipartParts.find(uploadId, partNumber);
    await part.commit();
    committed = true;

    const row = ctx.app.repos.multipartParts.upsert({
      uploadId,
      partNumber,
      tempPath: part.finalPath,
      sizeBytes: size,
      etag: md5Hex,
      checksumSha256: sha256Hex,
    });
    if (previous && previous.temp_path !== row.temp_path) {
      ctx.app.repos.pendingCleanup.enqueue({
        userId: requireUser(ctx),
        resourceType: "temp_file",
        resourceId: previous.temp_path,
        reason: "multipart_part_replaced",
      });
    }
    ctx.app.repos.audit.record({
      userId: requireUser(ctx),
      credentialId: ctx.credentialId,
      action: "s3.UploadPart",
      bucketName,
      bucketId: bucket.id,
      objectKey: key,
      statusCode: 200,
      bytesIn: size,
      requestId: ctx.requestId,
      detail: { partNumber, uploadId },
    });
    return new Response(null, {
      status: 200,
      headers: { ETag: quoteEtag(row.etag), "x-amz-request-id": ctx.requestId },
    });
  } catch (err) {
    if (committed) {
      await rm(part.finalPath, { force: true }).catch(() => {});
    } else {
      await part.abort();
    }
    throw err;
  }
}

export async function listParts(
  ctx: S3RequestContext,
  bucketName: string,
  key: string,
): Promise<Response> {
  const uploadId = ctx.url.searchParams.get("uploadId") ?? "";
  const upload = requireUpload(ctx, uploadId);
  const bucket = requireBucket(ctx, bucketName);
  if (upload.bucket_id !== bucket.id || upload.object_key !== key) {
    throw new S3Error("NoSuchUpload", { UploadId: uploadId });
  }
  const parts = ctx.app.repos.multipartParts.list(uploadId);
  const inner = parts
    .map(
      (p) =>
        `<Part>${tag("PartNumber", p.part_number)}${tag("ETag", quoteEtag(p.etag))}` +
        `${tag("LastModified", p.created_at)}${tag("Size", p.size_bytes)}</Part>`,
    )
    .join("");
  const body = xmlDocument(
    "ListPartsResult",
    tag("Bucket", bucketName) +
      tag("Key", key) +
      tag("UploadId", uploadId) +
      tag("StorageClass", "STANDARD") +
      tag("IsTruncated", "false") +
      inner,
  );
  return xmlResponse(body, 200, { "x-amz-request-id": ctx.requestId });
}

export async function abortMultipartUpload(
  ctx: S3RequestContext,
  bucketName: string,
  key: string,
): Promise<Response> {
  const uploadId = ctx.url.searchParams.get("uploadId") ?? "";
  const bucket = requireBucket(ctx, bucketName, "write");
  await withUploadLock(ctx.app.uploadLocks, uploadId, async () => {
    const upload = ctx.app.repos.multipartUploads.byId(uploadId);
    if (!upload || upload.bucket_id !== bucket.id || upload.object_key !== key) {
      throw new S3Error("NoSuchUpload", { UploadId: uploadId });
    }
    if (!ctx.app.repos.multipartUploads.markAborted(uploadId)) {
      throw new S3Error("NoSuchUpload", { UploadId: uploadId });
    }
    for (const part of ctx.app.repos.multipartParts.deleteAll(uploadId)) {
      ctx.app.repos.pendingCleanup.enqueue({
        userId: requireUser(ctx),
        resourceType: "temp_file",
        resourceId: part.temp_path,
        reason: "multipart_abort",
      });
    }
  });
  ctx.app.repos.audit.record({
    userId: requireUser(ctx),
    credentialId: ctx.credentialId,
    action: "s3.AbortMultipartUpload",
    bucketName,
    bucketId: bucket.id,
    objectKey: key,
    statusCode: 204,
    requestId: ctx.requestId,
  });
  return new Response(null, { status: 204, headers: { "x-amz-request-id": ctx.requestId } });
}

export async function listMultipartUploads(
  ctx: S3RequestContext,
  bucketName: string,
): Promise<Response> {
  const bucket = requireBucket(ctx, bucketName);
  const uploads = ctx.app.repos.multipartUploads.listOpenByBucket(bucket.id, 1000);
  const inner = uploads
    .map(
      (u) =>
        `<Upload>${tag("Key", u.object_key)}${tag("UploadId", u.id)}` +
        `${tag("Initiated", u.initiated_at)}${tag("StorageClass", "STANDARD")}</Upload>`,
    )
    .join("");
  const body = xmlDocument(
    "ListMultipartUploadsResult",
    tag("Bucket", bucketName) +
      tag("KeyMarker", "") +
      tag("UploadIdMarker", "") +
      tag("MaxUploads", "1000") +
      tag("IsTruncated", "false") +
      inner,
  );
  return xmlResponse(body, 200, { "x-amz-request-id": ctx.requestId });
}
