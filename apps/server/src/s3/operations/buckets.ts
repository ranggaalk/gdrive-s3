// S3 bucket operations (AGENTS.md §11-13): ListBuckets, CreateBucket,
// HeadBucket, DeleteBucket, ListObjects v1/v2, DeleteObjects.

import type { S3RequestContext } from "../context.ts";
import { S3Error } from "../errors.ts";
import { tag, xmlDocument, xmlResponse } from "../xml.ts";
import { isValidBucketName } from "../../util/bucket-name.ts";
import {
  BucketAlreadyOwnedError,
  BucketNotEmptyError,
  BucketNotFoundError,
} from "../../services/bucket-service.ts";
import { encodeContinuationToken, decodeContinuationToken } from "../pagination.ts";
import { quoteEtag } from "../etag.ts";
import { uriEncode } from "../../auth/sigv4-canonical.ts";
import type { AccessibleBucketRow } from "../../db/repositories/buckets.ts";

export async function listBuckets(ctx: S3RequestContext): Promise<Response> {
  const user = ctx.app.repos.users.findById(ctx.userId);
  const buckets = ctx.app.bucketAccess.list(ctx.userId);
  const bucketsXml = buckets
    .map((b) => `<Bucket>${tag("Name", b.name)}${tag("CreationDate", b.created_at)}</Bucket>`)
    .join("");
  const body = xmlDocument(
    "ListAllMyBucketsResult",
    `<Owner>${tag("ID", ctx.userId)}${tag("DisplayName", user?.email ?? "")}</Owner>` +
      `<Buckets>${bucketsXml}</Buckets>`,
  );
  return xmlResponse(body, 200, { "x-amz-request-id": ctx.requestId });
}

export async function createBucket(ctx: S3RequestContext, bucketName: string): Promise<Response> {
  if (!isValidBucketName(bucketName)) throw new S3Error("InvalidBucketName");
  if (ctx.app.repos.buckets.hasAccessibleName(ctx.userId, bucketName)) {
    throw new S3Error("BucketAlreadyOwnedByYou");
  }
  try {
    await ctx.app.bucketService.create(ctx.userId, bucketName);
  } catch (err) {
    if (err instanceof BucketAlreadyOwnedError) throw new S3Error("BucketAlreadyOwnedByYou");
    throw err;
  }
  ctx.app.repos.audit.record({
    userId: ctx.userId,
    credentialId: ctx.credentialId,
    action: "s3.CreateBucket",
    bucketName,
    statusCode: 200,
    requestId: ctx.requestId,
  });
  return new Response(null, {
    status: 200,
    headers: { Location: `/${bucketName}`, "x-amz-request-id": ctx.requestId },
  });
}

export async function headBucket(ctx: S3RequestContext, bucketName: string): Promise<Response> {
  const bucket = ctx.app.bucketAccess.findByName(ctx.userId, bucketName, "read");
  if (!bucket) throw new S3Error("NoSuchBucket", { BucketName: bucketName });
  try {
    await ctx.app.bucketAccess.verifyActorAccess(
      ctx.userId,
      bucket,
      false,
      ctx.signal ?? undefined,
    );
  } catch {
    throw new S3Error("AccessDenied");
  }
  return new Response(null, { status: 200, headers: { "x-amz-request-id": ctx.requestId } });
}

export async function deleteBucket(ctx: S3RequestContext, bucketName: string): Promise<Response> {
  let bucket;
  try {
    bucket = ctx.app.bucketAccess.findByName(ctx.userId, bucketName, "owner");
  } catch {
    throw new S3Error("AccessDenied");
  }
  if (!bucket) throw new S3Error("NoSuchBucket", { BucketName: bucketName });
  try {
    await ctx.app.bucketService.delete(ctx.userId, bucket.id);
  } catch (err) {
    if (err instanceof BucketNotEmptyError) throw new S3Error("BucketNotEmpty", { BucketName: bucketName });
    if (err instanceof BucketNotFoundError) throw new S3Error("NoSuchBucket", { BucketName: bucketName });
    throw err;
  }
  ctx.app.repos.audit.record({
    userId: ctx.userId,
    credentialId: ctx.credentialId,
    action: "s3.DeleteBucket",
    bucketName,
    statusCode: 204,
    requestId: ctx.requestId,
  });
  return new Response(null, { status: 204, headers: { "x-amz-request-id": ctx.requestId } });
}

type ListingQuery = {
  prefix: string;
  delimiter: string;
  encodingType: "" | "url";
  maxKeys: number;
};

async function resolveReadableBucket(
  ctx: S3RequestContext,
  bucketName: string,
): Promise<AccessibleBucketRow> {
  const bucket = ctx.app.bucketAccess.findByName(ctx.userId, bucketName, "read");
  if (!bucket) throw new S3Error("NoSuchBucket", { BucketName: bucketName });
  try {
    await ctx.app.bucketAccess.verifyActorAccess(
      ctx.userId,
      bucket,
      false,
      ctx.signal ?? undefined,
    );
  } catch {
    throw new S3Error("AccessDenied");
  }
  return bucket;
}

function listingQuery(ctx: S3RequestContext): ListingQuery {
  const q = ctx.url.searchParams;
  const rawMaxKeys = q.get("max-keys");
  if (rawMaxKeys !== null && !/^\d+$/.test(rawMaxKeys)) {
    throw new S3Error("InvalidArgument", { ArgumentName: "max-keys" });
  }
  const parsedMaxKeys = rawMaxKeys === null ? 1000 : Number(rawMaxKeys);
  if (!Number.isSafeInteger(parsedMaxKeys)) {
    throw new S3Error("InvalidArgument", { ArgumentName: "max-keys" });
  }

  const rawEncodingType = q.get("encoding-type") ?? "";
  if (rawEncodingType !== "" && rawEncodingType !== "url") {
    throw new S3Error("InvalidArgument", { ArgumentName: "encoding-type" });
  }
  return {
    prefix: q.get("prefix") ?? "",
    delimiter: q.get("delimiter") ?? "",
    encodingType: rawEncodingType,
    maxKeys: Math.min(parsedMaxKeys, 1000),
  };
}

function listingXml(
  result: { keys: Array<{ object_key: string; last_modified_at: string; etag: string; size_bytes: number; storage_class: string }>; commonPrefixes: string[] },
  encodingType: "" | "url",
): { encode: (value: string) => string; contents: string; commonPrefixes: string } {
  const encode = (value: string) => encodingType === "url" ? uriEncode(value) : value;
  const contents = result.keys
    .map(
      (object) =>
        `<Contents>${tag("Key", encode(object.object_key))}` +
        `${tag("LastModified", object.last_modified_at)}` +
        `${tag("ETag", quoteEtag(object.etag))}` +
        `${tag("Size", object.size_bytes)}${tag("StorageClass", object.storage_class)}</Contents>`,
    )
    .join("");
  const commonPrefixes = result.commonPrefixes
    .map((prefix) => `<CommonPrefixes>${tag("Prefix", encode(prefix))}</CommonPrefixes>`)
    .join("");
  return { encode, contents, commonPrefixes };
}

export async function listObjectsV1(ctx: S3RequestContext, bucketName: string): Promise<Response> {
  const bucket = await resolveReadableBucket(ctx, bucketName);
  const query = listingQuery(ctx);
  const marker = ctx.url.searchParams.get("marker") ?? "";
  const result = ctx.app.repos.objects.listObjects({
    bucketId: bucket.id,
    prefix: query.prefix,
    delimiter: query.delimiter,
    afterKey: marker,
    startAfter: marker,
    maxKeys: query.maxKeys,
  });
  const xml = listingXml(result, query.encodingType);
  const body = xmlDocument(
    "ListBucketResult",
    tag("Name", bucketName) +
      tag("Prefix", xml.encode(query.prefix)) +
      tag("Marker", xml.encode(marker)) +
      (result.nextMarker ? tag("NextMarker", xml.encode(result.nextMarker)) : "") +
      tag("MaxKeys", query.maxKeys) +
      (query.delimiter ? tag("Delimiter", xml.encode(query.delimiter)) : "") +
      tag("IsTruncated", result.isTruncated ? "true" : "false") +
      (query.encodingType === "url" ? tag("EncodingType", "url") : "") +
      xml.contents +
      xml.commonPrefixes,
  );
  return xmlResponse(body, 200, { "x-amz-request-id": ctx.requestId });
}

export async function listObjectsV2(ctx: S3RequestContext, bucketName: string): Promise<Response> {
  const bucket = await resolveReadableBucket(ctx, bucketName);
  const query = listingQuery(ctx);
  const startAfter = ctx.url.searchParams.get("start-after") ?? "";
  const contToken = ctx.url.searchParams.get("continuation-token");

  let afterKey = startAfter;
  let logicalStartAfter = startAfter;
  if (contToken) {
    const decoded = decodeContinuationToken(contToken, ctx.app.config.sessionSecret);
    if (
      !decoded ||
      decoded.b !== bucket.id ||
      decoded.p !== query.prefix ||
      decoded.d !== query.delimiter
    ) {
      throw new S3Error("InvalidArgument", { ArgumentName: "continuation-token" });
    }
    afterKey = decoded.a;
    logicalStartAfter = "";
  }

  const result = ctx.app.repos.objects.listObjects({
    bucketId: bucket.id,
    prefix: query.prefix,
    delimiter: query.delimiter,
    afterKey,
    startAfter: logicalStartAfter,
    maxKeys: query.maxKeys,
  });
  const xml = listingXml(result, query.encodingType);
  const nextToken =
    result.isTruncated && result.nextAfterKey
      ? encodeContinuationToken(
          { b: bucket.id, a: result.nextAfterKey, p: query.prefix, d: query.delimiter },
          ctx.app.config.sessionSecret,
        )
      : null;

  const body = xmlDocument(
    "ListBucketResult",
    tag("Name", bucketName) +
      tag("Prefix", xml.encode(query.prefix)) +
      (query.delimiter ? tag("Delimiter", xml.encode(query.delimiter)) : "") +
      tag("KeyCount", result.keys.length + result.commonPrefixes.length) +
      tag("MaxKeys", query.maxKeys) +
      tag("IsTruncated", result.isTruncated ? "true" : "false") +
      (query.encodingType === "url" ? tag("EncodingType", "url") : "") +
      (startAfter ? tag("StartAfter", xml.encode(startAfter)) : "") +
      (nextToken ? tag("NextContinuationToken", nextToken) : "") +
      (contToken ? tag("ContinuationToken", contToken) : "") +
      xml.contents +
      xml.commonPrefixes,
  );
  return xmlResponse(body, 200, { "x-amz-request-id": ctx.requestId });
}
