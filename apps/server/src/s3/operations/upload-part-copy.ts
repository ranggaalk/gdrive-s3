// UploadPartCopy: fill a multipart part from a byte range of another object.
//
// This is how S3 does large or cross-bucket copies — the caller slices the
// source into parts and the server assembles them, so a multi-gigabyte copy
// never depends on one long-lived request. It is also the only ranged copy S3
// offers; CopyObject itself has no range form.

import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { requireUser, type S3RequestContext } from "../context.ts";
import { authorizeBucket, verifyDriveAccess } from "../authorize.ts";
import { openCopySourceStream, resolveCopySource } from "../copy-source.ts";
import { S3Error } from "../errors.ts";
import { openAtomicPart } from "../../util/multipart-path.ts";
import { quoteEtag } from "../etag.ts";
import { tag, xmlDocument, xmlResponse } from "../xml.ts";

export async function uploadPartCopy(
  ctx: S3RequestContext,
  bucketName: string,
  key: string,
): Promise<Response> {
  const userId = requireUser(ctx);
  const uploadId = ctx.url.searchParams.get("uploadId") ?? "";
  const partNumber = Number(ctx.url.searchParams.get("partNumber"));
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > ctx.app.config.maxParts) {
    throw new S3Error("InvalidArgument", { ArgumentName: "partNumber" });
  }

  const targetAuth = authorizeBucket(ctx, bucketName, "s3:PutObject", key);
  const targetBucket = targetAuth.bucket;
  await verifyDriveAccess(ctx, targetAuth, true);

  const upload = ctx.app.repos.multipartUploads.byId(uploadId);
  if (!upload || upload.status !== "open") throw new S3Error("NoSuchUpload", { UploadId: uploadId });
  if (upload.bucket_id !== targetBucket.id || upload.object_key !== key) {
    throw new S3Error("InvalidRequest", { Reason: "Upload does not match bucket/key." });
  }

  const source = resolveCopySource(ctx, { allowRange: true });
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

  // Parts are staged as plaintext on local disk and the assembled object is
  // encrypted once at completion, so nothing is encrypted here — see
  // multipart-complete.ts.
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
  const slot = await ctx.app.driveLimits.download(source.driveActorUserId, ctx.signal ?? undefined);
  try {
    const body = await openCopySourceStream(ctx, source);
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      size += value.byteLength;
      if (size > ctx.app.config.maxSinglePutBytes) throw new S3Error("EntityTooLarge");
      md5.update(value);
      sha256.update(value);
      await part.handle.write(value);
    }

    const previous = ctx.app.repos.multipartParts.find(uploadId, partNumber);
    await part.commit();
    committed = true;

    const row = ctx.app.repos.multipartParts.upsert({
      uploadId,
      partNumber,
      tempPath: part.finalPath,
      sizeBytes: size,
      etag: md5.digest("hex"),
      checksumSha256: sha256.digest("hex"),
    });
    // Replacing a part leaves its old temp file behind otherwise.
    if (previous && previous.temp_path !== row.temp_path) {
      await rm(previous.temp_path, { force: true }).catch(() => {});
    }

    ctx.app.repos.audit.record({
      userId,
      credentialId: ctx.credentialId,
      action: "s3.UploadPartCopy",
      bucketName,
      bucketId: targetBucket.id,
      objectKey: key,
      statusCode: 200,
      bytesIn: size,
      requestId: ctx.requestId,
      detail: {
        uploadId,
        partNumber,
        sourceBucket: source.bucketName,
        ranged: source.range !== null,
        crossUser: source.bucket.user_id !== targetBucket.user_id,
      },
    });

    const headers: Record<string, string> = { "x-amz-request-id": ctx.requestId };
    if (source.object.version_id !== "null") {
      headers["x-amz-copy-source-version-id"] = source.object.version_id;
    }
    return xmlResponse(
      xmlDocument(
        "CopyPartResult",
        tag("LastModified", source.object.last_modified_at) + tag("ETag", quoteEtag(row.etag)),
      ),
      200,
      headers,
    );
  } catch (error) {
    if (!committed) await part.abort().catch(() => {});
    throw error;
  } finally {
    slot.release();
  }
}
