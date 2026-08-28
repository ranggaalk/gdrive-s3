// S3 object operations (AGENTS.md §11-13): PutObject, GetObject, HeadObject,
// DeleteObject, DeleteObjects (POST ?delete).

import type { S3RequestContext } from "../context.ts";
import { authorizeBucket, verifyDriveAccess } from "../authorize.ts";
import { isObjectAcl } from "../acl.ts";
import { S3Error } from "../errors.ts";
import { quoteEtag } from "../etag.ts";
import { parseObjectMetadata, applyObjectMetadataHeaders } from "../metadata.ts";
import { validateObjectKey } from "../key.ts";
import { tag, xmlDocument, xmlResponse } from "../xml.ts";
import { evaluateConditions } from "../conditions.ts";
import { BodyTooLargeError, readBoundedText } from "../../util/body-size.ts";
import { assertPayloadDigest, preparePayload } from "../payload-body.ts";
import {
  ObjectAccessError,
  ObjectNotFoundError,
  ObjectService,
} from "../../services/object-service.ts";

/** The canned ACL a PUT asked for, defaulting to private as S3 does. */
function requestedAcl(ctx: S3RequestContext): string {
  const raw = ctx.headers.get("x-amz-acl");
  if (raw === null) return "private";
  if (!isObjectAcl(raw)) throw new S3Error("InvalidArgument", { ArgumentName: "x-amz-acl" });
  return raw;
}

export async function putObject(
  ctx: S3RequestContext,
  bucketName: string,
  key: string,
): Promise<Response> {
  validateObjectKey(key, true);
  if (ctx.headers.has("x-amz-copy-source")) throw new S3Error("NotImplemented");

  const acl = requestedAcl(ctx);
  const authorized = authorizeBucket(ctx, bucketName, "s3:PutObject", key);
  const { bucket } = authorized;
  await verifyDriveAccess(ctx, authorized, true);
  const payload = preparePayload(ctx);
  const meta = parseObjectMetadata(ctx.headers);
  let uploaded;
  try {
    uploaded = await new ObjectService(ctx.app).upload({
      actorUserId: authorized.actorUserId,
      bucket,
      key,
      acl,
      requestId: `${ctx.requestId}:put:${crypto.randomUUID()}`,
      body: payload.body,
      contentLength: payload.contentLength,
      metadata: meta,
      signal: ctx.signal ?? undefined,
      verify: (result) => assertPayloadDigest(payload.mode, result.sha256Hex),
    });
  } catch (error) {
    if (error instanceof ObjectAccessError) throw new S3Error("AccessDenied");
    throw error;
  }

  ctx.app.repos.audit.record({
    userId: ctx.userId,
    credentialId: ctx.credentialId,
    action: "s3.PutObject",
    bucketName,
    bucketId: bucket.id,
    objectKey: key,
    statusCode: 200,
    bytesIn: uploaded.result.size,
    requestId: ctx.requestId,
  });

  return new Response(null, {
    status: 200,
    headers: {
      ETag: quoteEtag(uploaded.result.md5Hex),
      "x-amz-request-id": ctx.requestId,
    },
  });
}

export async function headObject(
  ctx: S3RequestContext,
  bucketName: string,
  key: string,
): Promise<Response> {
  const authorized = authorizeBucket(ctx, bucketName, "s3:GetObject", key);
  await verifyDriveAccess(ctx, authorized, false);
  const obj = authorized.object;
  if (!obj) throw new S3Error("NoSuchKey", { Key: key });
  if (evaluateConditions(ctx.headers, obj) === "not-modified") {
    return new Response(null, {
      status: 304,
      headers: { ETag: quoteEtag(obj.etag), "x-amz-request-id": ctx.requestId },
    });
  }

  const headers = new Headers({
    "Content-Length": String(obj.size_bytes),
    ETag: quoteEtag(obj.etag),
    "Last-Modified": new Date(obj.last_modified_at).toUTCString(),
    "Accept-Ranges": "bytes",
    "x-amz-request-id": ctx.requestId,
  });
  applyObjectMetadataHeaders(headers, obj);
  return new Response(null, { status: 200, headers });
}

export async function getObject(
  ctx: S3RequestContext,
  bucketName: string,
  key: string,
): Promise<Response> {
  const authorized = authorizeBucket(ctx, bucketName, "s3:GetObject", key);
  const { bucket } = authorized;
  const obj = authorized.object;
  if (!obj) throw new S3Error("NoSuchKey", { Key: key });
  if (obj.status !== "active") throw new S3Error("NoSuchKey", { Key: key });
  if (evaluateConditions(ctx.headers, obj) === "not-modified") {
    return new Response(null, {
      status: 304,
      headers: { ETag: quoteEtag(obj.etag), "x-amz-request-id": ctx.requestId },
    });
  }

  let download;
  try {
    download = await new ObjectService(ctx.app).download({
      actorUserId: authorized.actorUserId,
      bucket,
      object: obj,
      range: ctx.headers.get("range"),
      signal: ctx.signal ?? undefined,
    });
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      throw new S3Error("NoSuchKey", { Key: key });
    }
    if (error instanceof ObjectAccessError) throw new S3Error("AccessDenied");
    throw error;
  }

  const headers = new Headers({
    ETag: quoteEtag(obj.etag),
    "Last-Modified": new Date(obj.last_modified_at).toUTCString(),
    "Accept-Ranges": "bytes",
    "Content-Length": String(download.contentLength),
    "x-amz-request-id": ctx.requestId,
  });
  applyObjectMetadataHeaders(headers, obj);
  if (download.contentRange) headers.set("Content-Range", download.contentRange);

  ctx.app.repos.audit.record({
    userId: ctx.userId,
    credentialId: ctx.credentialId,
    action: "s3.GetObject",
    bucketName,
    bucketId: bucket.id,
    objectKey: key,
    statusCode: download.status,
    bytesOut: download.contentLength,
    requestId: ctx.requestId,
  });

  return new Response(download.body, { status: download.status, headers });
}

export async function deleteObject(
  ctx: S3RequestContext,
  bucketName: string,
  key: string,
): Promise<Response> {
  const authorized = authorizeBucket(ctx, bucketName, "s3:DeleteObject", key);
  const { bucket } = authorized;
  await verifyDriveAccess(ctx, authorized, true);
  const existing = authorized.object;
  // Deleting a non-existent object is idempotent success in S3.
  if (existing) {
    try {
      await new ObjectService(ctx.app).delete({
        actorUserId: authorized.actorUserId,
        bucket,
        object: existing,
        reason: "object_delete",
        signal: ctx.signal ?? undefined,
      });
    } catch (error) {
      if (error instanceof ObjectAccessError) throw new S3Error("AccessDenied");
      throw error;
    }
  }
  ctx.app.repos.audit.record({
    userId: ctx.userId,
    credentialId: ctx.credentialId,
    action: "s3.DeleteObject",
    bucketName,
    bucketId: bucket.id,
    objectKey: key,
    statusCode: 204,
    requestId: ctx.requestId,
  });
  return new Response(null, { status: 204, headers: { "x-amz-request-id": ctx.requestId } });
}

export async function deleteObjects(
  ctx: S3RequestContext,
  bucketName: string,
): Promise<Response> {
  const authorized = authorizeBucket(ctx, bucketName, "s3:DeleteObject");
  const { bucket } = authorized;
  await verifyDriveAccess(ctx, authorized, true);
  let rawBody: string;
  try {
    rawBody = await readBoundedText(ctx.body, ctx.app.config.maxS3XmlBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new S3Error("EntityTooLarge");
    throw error;
  }
  // Minimal, safe extraction of <Key>…</Key> nodes; no external-entity parser.
  const keys: string[] = [];
  const re = /<Key>([\s\S]*?)<\/Key>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawBody)) !== null) {
    keys.push(
      m[1]!
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'"),
    );
  }

  const deleted: string[] = [];
  for (const key of keys) {
    const existing = ctx.app.repos.objects.findByKey(bucket.id, key);
    if (existing) {
      try {
        await new ObjectService(ctx.app).delete({
          actorUserId: authorized.actorUserId,
          bucket,
          object: existing,
          reason: "multi_object_delete",
          signal: ctx.signal ?? undefined,
        });
      } catch (error) {
        if (error instanceof ObjectAccessError) throw new S3Error("AccessDenied");
        throw error;
      }
    }
    deleted.push(key);
    ctx.app.repos.audit.record({
      userId: ctx.userId,
      credentialId: ctx.credentialId,
      action: "s3.DeleteObject",
      bucketName,
      bucketId: bucket.id,
      objectKey: key,
      statusCode: 204,
      requestId: ctx.requestId,
    });
  }

  const body = xmlDocument(
    "DeleteResult",
    deleted.map((k) => `<Deleted>${tag("Key", k)}</Deleted>`).join(""),
  );
  return xmlResponse(body, 200, { "x-amz-request-id": ctx.requestId });
}
