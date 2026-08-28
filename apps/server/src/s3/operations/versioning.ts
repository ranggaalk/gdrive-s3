// The ?versioning and ?versions bucket sub-resources.

import { requireUser, type S3RequestContext } from "../context.ts";
import { authorizeBucket } from "../authorize.ts";
import { S3Error } from "../errors.ts";
import { quoteEtag } from "../etag.ts";
import { tag, xmlDocument, xmlResponse } from "../xml.ts";
import { uriEncode } from "../../auth/sigv4-canonical.ts";
import { BodyTooLargeError, readBoundedText } from "../../util/body-size.ts";

export async function getBucketVersioning(
  ctx: S3RequestContext,
  bucketName: string,
): Promise<Response> {
  const { bucket } = authorizeBucket(ctx, bucketName, "s3:ListBucket");
  // S3 returns an empty document for a bucket that has never had versioning
  // configured, rather than the word "Disabled".
  const body = xmlDocument(
    "VersioningConfiguration",
    bucket.versioning === "Disabled" ? "" : tag("Status", bucket.versioning),
  );
  return xmlResponse(body, 200, { "x-amz-request-id": ctx.requestId });
}

export async function putBucketVersioning(
  ctx: S3RequestContext,
  bucketName: string,
): Promise<Response> {
  const userId = requireUser(ctx);
  const { bucket } = authorizeBucket(ctx, bucketName, "s3:PutBucketAcl");

  let raw: string;
  try {
    raw = await readBoundedText(ctx.body, ctx.app.config.maxS3XmlBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new S3Error("EntityTooLarge");
    throw error;
  }

  const status = /<Status>\s*([^<]*?)\s*<\/Status>/.exec(raw)?.[1];
  if (status !== "Enabled" && status !== "Suspended") {
    throw new S3Error("MalformedXML", {
      Reason: "Status must be Enabled or Suspended.",
    });
  }
  // S3 has no way back to Disabled once versioning has been switched on;
  // Suspended is the off switch, and it keeps existing versions.
  ctx.app.repos.buckets.setVersioning(bucket.id, status);

  ctx.app.repos.audit.record({
    userId,
    credentialId: ctx.credentialId,
    action: "s3.PutBucketVersioning",
    bucketName,
    bucketId: bucket.id,
    statusCode: 200,
    requestId: ctx.requestId,
    detail: { status },
  });
  return new Response(null, { status: 200, headers: { "x-amz-request-id": ctx.requestId } });
}

export async function listObjectVersions(
  ctx: S3RequestContext,
  bucketName: string,
): Promise<Response> {
  const { bucket } = authorizeBucket(ctx, bucketName, "s3:ListBucket");
  const q = ctx.url.searchParams;

  const rawMaxKeys = q.get("max-keys");
  if (rawMaxKeys !== null && !/^\d+$/.test(rawMaxKeys)) {
    throw new S3Error("InvalidArgument", { ArgumentName: "max-keys" });
  }
  const maxKeys = Math.min(rawMaxKeys === null ? 1000 : Number(rawMaxKeys), 1000);

  const encodingType = q.get("encoding-type") ?? "";
  if (encodingType !== "" && encodingType !== "url") {
    throw new S3Error("InvalidArgument", { ArgumentName: "encoding-type" });
  }
  const encode = (value: string) => (encodingType === "url" ? uriEncode(value) : value);

  const prefix = q.get("prefix") ?? "";
  const delimiter = q.get("delimiter") ?? "";
  const result = ctx.app.repos.objectVersions.listVersions({
    bucketId: bucket.id,
    prefix,
    delimiter,
    keyMarker: q.get("key-marker") ?? "",
    versionIdMarker: q.get("version-id-marker") ?? "",
    maxKeys,
  });

  const entries = result.versions
    .map((entry) => {
      const inner =
        tag("Key", encode(entry.key)) +
        tag("VersionId", entry.versionId) +
        tag("IsLatest", entry.isLatest ? "true" : "false") +
        tag("LastModified", entry.lastModified) +
        (entry.isDeleteMarker
          ? ""
          : tag("ETag", quoteEtag(entry.etag ?? "")) +
            tag("Size", entry.size) +
            tag("StorageClass", entry.storageClass));
      return entry.isDeleteMarker
        ? `<DeleteMarker>${inner}</DeleteMarker>`
        : `<Version>${inner}</Version>`;
    })
    .join("");

  const commonPrefixes = result.commonPrefixes
    .map((value) => `<CommonPrefixes>${tag("Prefix", encode(value))}</CommonPrefixes>`)
    .join("");

  const body = xmlDocument(
    "ListVersionsResult",
    tag("Name", bucketName) +
      tag("Prefix", encode(prefix)) +
      (delimiter ? tag("Delimiter", encode(delimiter)) : "") +
      tag("MaxKeys", maxKeys) +
      tag("IsTruncated", result.isTruncated ? "true" : "false") +
      (result.nextKeyMarker ? tag("NextKeyMarker", encode(result.nextKeyMarker)) : "") +
      (result.nextVersionIdMarker ? tag("NextVersionIdMarker", result.nextVersionIdMarker) : "") +
      (encodingType === "url" ? tag("EncodingType", "url") : "") +
      entries +
      commonPrefixes,
  );
  return xmlResponse(body, 200, { "x-amz-request-id": ctx.requestId });
}
