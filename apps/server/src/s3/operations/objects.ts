// S3 object operations (AGENTS.md §11-13): PutObject, GetObject, HeadObject,
// DeleteObject, DeleteObjects (POST ?delete).

import type { S3RequestContext } from "../context.ts";
import { authorizeBucket, verifyDriveAccess } from "../authorize.ts";
import { isObjectAcl } from "../acl.ts";
import {
  applySseResponseHeaders,
  assertCustomerKeyMatches,
  parseSseRequest,
} from "../sse.ts";
import { EncryptionService } from "../../services/encryption-service.ts";
import { newVersionId } from "../../db/repositories/object-versions.ts";
import {
  assertDeletable,
  bypassRequested,
  evaluateDelete,
  parseLockHeaders,
  resolveDefaultRetention,
} from "../object-lock.ts";
import type { AccessibleBucketRow } from "../../db/repositories/buckets.ts";
import type { ObjectRow } from "../../db/repositories/objects.ts";
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

/** The SSE-C key on a read request, or null when none was sent. */
function customerKeyFrom(ctx: S3RequestContext): { key: Buffer; keyMd5: string } | null {
  const parsed = parseSseRequest(ctx.headers);
  return parsed.kind === "sse-c" ? { key: parsed.key, keyMd5: parsed.keyMd5 } : null;
}

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
  const sseRequest = parseSseRequest(ctx.headers);
  const authorized = authorizeBucket(ctx, bucketName, "s3:PutObject", key);
  const { bucket } = authorized;
  await verifyDriveAccess(ctx, authorized, true);
  // The bucket owner's key catalogue backs the encryption, since the bytes
  // land in their Drive regardless of who is writing.
  const encryption = new EncryptionService(ctx.app).planFor({
    ownerUserId: bucket.user_id,
    bucket,
    request: sseRequest,
  });
  // A "Suspended" bucket keeps existing versions but writes the literal
  // 'null' version id, exactly as S3 does.
  const versionId = bucket.versioning === "Enabled" ? newVersionId() : "null";

  // An explicit lock wins; otherwise the bucket default applies, which is what
  // makes default retention a safety net rather than something each client has
  // to remember.
  const requestedLock = parseLockHeaders(ctx.headers);
  const defaultRetention = requestedLock.mode
    ? null
    : resolveDefaultRetention(bucket.object_lock_default_json);
  const lock = bucket.object_lock_enabled
    ? {
        mode: requestedLock.mode ?? defaultRetention?.mode ?? null,
        retainUntil: requestedLock.retainUntil ?? defaultRetention?.retainUntil ?? null,
        legalHold: requestedLock.legalHold,
      }
    : null;
  if (!bucket.object_lock_enabled && (requestedLock.mode || requestedLock.legalHold)) {
    throw new S3Error("InvalidRequest", {
      Reason: "Object Lock is not enabled for this bucket.",
    });
  }
  const payload = preparePayload(ctx);
  const meta = parseObjectMetadata(ctx.headers);
  let uploaded;
  try {
    uploaded = await new ObjectService(ctx.app).upload({
      actorUserId: authorized.actorUserId,
      bucket,
      key,
      acl,
      encryption,
      versioning: bucket.versioning,
      versionId,
      lock,
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

  const putHeaders = new Headers({
    ETag: quoteEtag(uploaded.result.md5Hex),
    "x-amz-request-id": ctx.requestId,
  });
  if (encryption) {
    applySseResponseHeaders(putHeaders, {
      sse_algorithm: encryption.algorithm,
      kms_key_id: encryption.kmsKeyId,
      customer_key_md5: encryption.customerKeyMd5,
    });
  }
  if (versionId !== "null") putHeaders.set("x-amz-version-id", versionId);
  return new Response(null, { status: 200, headers: putHeaders });
}

export async function headObject(
  ctx: S3RequestContext,
  bucketName: string,
  key: string,
): Promise<Response> {
  const authorized = authorizeBucket(ctx, bucketName, "s3:GetObject", key);
  await verifyDriveAccess(ctx, authorized, false);
  const obj = authorized.object;
  if (!obj) {
    const marker = ctx.app.repos.objectVersions.findLatestDeleteMarker(
      authorized.bucket.id,
      key,
    );
    if (marker) throw new S3Error("NoSuchKey", { Key: key, DeleteMarker: "true" });
    throw new S3Error("NoSuchKey", { Key: key });
  }
  const headEncryption = ctx.app.repos.objectEncryption.find(obj.id);
  // A HEAD reads no bytes, but the key still has to be right or the caller
  // would believe it can read the object when it cannot.
  assertCustomerKeyMatches(
    customerKeyFrom(ctx),
    headEncryption?.customer_key_md5 ?? null,
  );
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
  applySseResponseHeaders(headers, headEncryption);
  if (obj.version_id !== "null") headers.set("x-amz-version-id", obj.version_id);
  return new Response(null, { status: 200, headers });
}

export async function getObject(
  ctx: S3RequestContext,
  bucketName: string,
  key: string,
): Promise<Response> {
  const authorized = authorizeBucket(ctx, bucketName, "s3:GetObject", key);
  const { bucket } = authorized;
  const requestedVersion = ctx.url.searchParams.get("versionId");

  if (requestedVersion) {
    return getObjectVersion(ctx, authorized, bucketName, key, requestedVersion);
  }

  const obj = authorized.object;
  if (!obj) {
    // A key hidden behind a delete marker is a 404, but S3 flags it so the
    // caller can tell "deleted" from "never existed".
    const marker = ctx.app.repos.objectVersions.findLatestDeleteMarker(bucket.id, key);
    if (marker) {
      throw new S3Error("NoSuchKey", { Key: key, DeleteMarker: "true" });
    }
    throw new S3Error("NoSuchKey", { Key: key });
  }
  if (obj.status !== "active") throw new S3Error("NoSuchKey", { Key: key });
  // Checked here as well as inside the decryptor, because a plaintext object
  // never reaches the decryptor and a key sent for it must still be refused
  // rather than silently ignored.
  assertCustomerKeyMatches(
    customerKeyFrom(ctx),
    ctx.app.repos.objectEncryption.find(obj.id)?.customer_key_md5 ?? null,
  );
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
      customerKey: customerKeyFrom(ctx),
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
  applySseResponseHeaders(headers, ctx.app.repos.objectEncryption.find(obj.id));
  if (obj.version_id !== "null") headers.set("x-amz-version-id", obj.version_id);
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
  const versionParam = ctx.url.searchParams.get("versionId");
  if (versionParam) {
    return deleteObjectVersion(ctx, authorized, key, versionParam);
  }

  const existing = authorized.object;
  if (existing) {
    // A delete marker still hides the data rather than destroying it, so under
    // versioning a lock does not block one. Without versioning the bytes would
    // really go, which retention exists to prevent.
    const wouldDestroy = bucket.versioning !== "Enabled";
    if (wouldDestroy) {
      assertDeletable(
        evaluateDelete({
          state: existing,
          bypassGovernance: bypassRequested(ctx.headers),
          isBucketOwner: ctx.userId !== null && ctx.userId === bucket.user_id,
        }),
      );
    }
  }
  let deleteMarkerVersionId: string | null = null;
  // Deleting a non-existent object is idempotent success in S3.
  if (existing) {
    try {
      const outcome = await new ObjectService(ctx.app).delete({
        actorUserId: authorized.actorUserId,
        bucket,
        object: existing,
        reason: "object_delete",
        signal: ctx.signal ?? undefined,
      });
      deleteMarkerVersionId = outcome.deleteMarkerVersionId;
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
  const deleteHeaders = new Headers({ "x-amz-request-id": ctx.requestId });
  if (deleteMarkerVersionId) {
    deleteHeaders.set("x-amz-version-id", deleteMarkerVersionId);
    deleteHeaders.set("x-amz-delete-marker", "true");
  }
  return new Response(null, { status: 204, headers: deleteHeaders });
}

/**
 * GET ?versionId= — read one specific version.
 *
 * The current version still lives in `objects`, so it is served through the
 * ordinary path; only superseded versions come out of `object_versions`, where
 * they are reconstituted into an ObjectRow shape the download path understands.
 */
async function getObjectVersion(
  ctx: S3RequestContext,
  authorized: { bucket: AccessibleBucketRow; actorUserId: string; object: ObjectRow | null },
  bucketName: string,
  key: string,
  versionId: string,
): Promise<Response> {
  const { bucket } = authorized;
  const current = ctx.app.repos.objects.findByKey(bucket.id, key);
  let source: ObjectRow;
  let encryption: ReturnType<typeof ctx.app.repos.objectEncryption.find>;

  if (current && current.version_id === versionId) {
    source = current;
    encryption = ctx.app.repos.objectEncryption.find(current.id);
  } else {
    const archived = ctx.app.repos.objectVersions.find(bucket.id, key, versionId);
    if (!archived) throw new S3Error("NoSuchVersion", { VersionId: versionId });
    if (archived.is_delete_marker === 1) {
      // S3 answers a GET on a delete marker with 405, not 404: the version
      // exists, it just has no body to return.
      throw new S3Error("MethodNotAllowed", { DeleteMarker: "true" });
    }
    if (!archived.drive_file_id || !archived.etag) throw new S3Error("InternalError");

    source = {
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
  }

  assertCustomerKeyMatches(customerKeyFrom(ctx), encryption?.customer_key_md5 ?? null);

  let download;
  try {
    download = await new ObjectService(ctx.app).download({
      actorUserId: authorized.actorUserId,
      customerKey: customerKeyFrom(ctx),
      bucket,
      object: source,
      range: ctx.headers.get("range"),
      signal: ctx.signal ?? undefined,
      // An archived version has no row in `objects`, so the freshness check
      // the normal path does cannot apply to it.
      skipCurrentCheck: source.id !== current?.id,
      encryptionOverride: encryption,
    });
  } catch (error) {
    if (error instanceof ObjectNotFoundError) throw new S3Error("NoSuchVersion", { VersionId: versionId });
    if (error instanceof ObjectAccessError) throw new S3Error("AccessDenied");
    throw error;
  }

  const headers = new Headers({
    ETag: quoteEtag(source.etag),
    "Last-Modified": new Date(source.last_modified_at).toUTCString(),
    "Accept-Ranges": "bytes",
    "Content-Length": String(download.contentLength),
    "x-amz-version-id": source.version_id,
    "x-amz-request-id": ctx.requestId,
  });
  applyObjectMetadataHeaders(headers, source);
  applySseResponseHeaders(headers, encryption);
  if (download.contentRange) headers.set("Content-Range", download.contentRange);

  ctx.app.repos.audit.record({
    userId: ctx.userId,
    credentialId: ctx.credentialId,
    action: "s3.GetObjectVersion",
    bucketName,
    bucketId: bucket.id,
    objectKey: key,
    statusCode: download.status,
    bytesOut: download.contentLength,
    requestId: ctx.requestId,
    detail: { versionId },
  });

  return new Response(download.body, { status: download.status, headers });
}

/**
 * DELETE ?versionId= — remove one specific version permanently.
 *
 * Two cases matter. Deleting a *delete marker* un-hides the key: the newest
 * surviving version is promoted back into `objects`, which is how S3's
 * "undelete" works. Deleting the current version does the same promotion, so a
 * key never ends up with versions but no current row.
 */
async function deleteObjectVersion(
  ctx: S3RequestContext,
  authorized: { bucket: AccessibleBucketRow; actorUserId: string },
  key: string,
  versionId: string,
): Promise<Response> {
  const { bucket } = authorized;
  const versions = ctx.app.repos.objectVersions;
  const headers = new Headers({ "x-amz-request-id": ctx.requestId });
  const isOwner = ctx.userId !== null && ctx.userId === bucket.user_id;
  const bypass = bypassRequested(ctx.headers);

  const current = ctx.app.repos.objects.findByKey(bucket.id, key);
  if (current && current.version_id === versionId) {
    // Deleting a specific version destroys its bytes outright, so the lock
    // applies here even under versioning.
    assertDeletable(
      evaluateDelete({ state: current, bypassGovernance: bypass, isBucketOwner: isOwner }),
    );
    // Removing the live version: drop it, then promote the newest archived one.
    ctx.app.repos.objects.deleteAndQueueCleanup({
      userId: bucket.user_id,
      bucketId: bucket.id,
      objectKey: key,
      reason: "object_version_delete",
      driveTargetId: bucket.drive_target_id,
    });
    promoteNewestVersion(ctx, bucket, key);
    headers.set("x-amz-version-id", versionId);
    return new Response(null, { status: 204, headers });
  }

  const archived = versions.find(bucket.id, key, versionId);
  if (!archived) throw new S3Error("NoSuchVersion", { VersionId: versionId });
  assertDeletable(
    evaluateDelete({ state: archived, bypassGovernance: bypass, isBucketOwner: isOwner }),
  );

  versions.delete(bucket.id, key, versionId);
  if (archived.is_delete_marker === 1) {
    headers.set("x-amz-delete-marker", "true");
    // The key was hidden by this marker; bring back what it was hiding.
    promoteNewestVersion(ctx, bucket, key);
  } else if (archived.drive_file_id) {
    // A retained version's bytes are only reachable through this row, so
    // removing it must release the Drive file.
    ctx.app.repos.pendingCleanup.enqueue({
      userId: bucket.user_id,
      resourceType: "drive_file",
      resourceId: archived.drive_file_id,
      reason: "object_version_delete",
      driveTargetId: bucket.drive_target_id,
    });
  }

  headers.set("x-amz-version-id", versionId);
  return new Response(null, { status: 204, headers });
}

/** Move the newest surviving version back into `objects` as the current one. */
function promoteNewestVersion(
  ctx: S3RequestContext,
  bucket: AccessibleBucketRow,
  key: string,
): void {
  const versions = ctx.app.repos.objectVersions;
  // Any marker still flagged latest would keep the key hidden.
  versions.clearLatest(bucket.id, key);
  const newest = versions.newestVersion(bucket.id, key);
  if (!newest || !newest.drive_file_id || !newest.etag) return;

  const promoted = ctx.app.repos.objects.upsert({
    bucketId: bucket.id,
    objectKey: key,
    driveFileId: newest.drive_file_id,
    sizeBytes: newest.size_bytes,
    contentType: newest.content_type,
    etag: newest.etag,
    checksumSha256: newest.checksum_sha256,
    metadata: JSON.parse(newest.metadata_json) as Record<string, string>,
    cacheControl: newest.cache_control,
    contentDisposition: newest.content_disposition,
    contentEncoding: newest.content_encoding,
    contentLanguage: newest.content_language,
    expiresAt: newest.expires_at,
    acl: newest.acl as ObjectRow["acl"],
    versionId: newest.version_id,
  });

  // Carry the encryption metadata across, or the promoted object would be
  // read as plaintext and return garbage.
  if (newest.sse_algorithm && newest.sse_iv) {
    ctx.app.repos.objectEncryption.put({
      objectId: promoted.current.id,
      algorithm: newest.sse_algorithm as "AES256" | "aws:kms",
      kmsKeyId: newest.sse_kms_key_id,
      kmsKeyVersion: newest.sse_kms_key_version,
      wrappedDataKey: newest.sse_wrapped_data_key,
      iv: newest.sse_iv,
      customerKeyMd5: newest.sse_customer_key_md5,
    });
  }
  versions.delete(bucket.id, key, newest.version_id);
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
