import type { AppContext } from "../context.ts";
import type { SessionRow } from "../db/repositories/sessions.ts";
import { ObjectAccessError, ObjectNotFoundError, ObjectService } from "../services/object-service.ts";
import {
  PresignCredentialNotFoundError,
  PresignExpiryError,
} from "../services/presigned-url-service.ts";
import { S3Error } from "../s3/errors.ts";
import { validateObjectKey } from "../s3/key.ts";
import { parseObjectMetadata } from "../s3/metadata.ts";
import { apiError, mapBodyReadError, ok, readJson } from "./api-helpers.ts";
import { isPreviewableContentType, objectResponseHeaders } from "./object-http.ts";

export async function handleObjects(
  ctx: AppContext,
  req: Request,
  session: SessionRow,
  requestId: string,
  bucketId: string,
  segments: string[],
): Promise<Response> {
  const userId = session.user_id;
  const service = new ObjectService(ctx);

  if (segments.length === 0 || (segments.length === 1 && segments[0] === "")) {
    if (req.method === "GET") return await list(ctx, req, userId, requestId, bucketId);
    if (req.method === "POST") {
      let bucket;
      try {
        bucket = ctx.bucketAccess.findById(userId, bucketId, "write");
      } catch {
        return apiError("ACCESS_DENIED", "Akses tulis bucket ditolak.", 403, requestId);
      }
      if (!bucket) return apiError("NOT_FOUND", "Bucket tidak ditemukan.", 404, requestId);
      const url = new URL(req.url);
      const key = url.searchParams.get("key");
      if (!key) return apiError("INVALID", "Object key wajib diisi.", 400, requestId);
      try {
        validateObjectKey(key, true);
      } catch {
        return apiError("INVALID", "Object key tidak valid.", 400, requestId);
      }
      if (!req.body) return apiError("INVALID", "Body file wajib diisi.", 400, requestId);
      const declared = parseContentLength(req.headers.get("content-length"));
      if (declared === "invalid") {
        return apiError("INVALID", "Content-Length tidak valid.", 400, requestId);
      }
      try {
        const uploaded = await service.upload({
          actorUserId: userId,
          bucket,
          key,
          requestId: `${requestId}:upload:${crypto.randomUUID()}`,
          body: req.body,
          contentLength: declared,
          metadata: parseDashboardMetadata(req.headers),
          signal: req.signal,
        });
        ctx.repos.audit.record({
          userId,
          action: "object.upload",
          bucketName: bucket.name,
          bucketId,
          objectKey: key,
          statusCode: 201,
          bytesIn: uploaded.result.size,
          requestId,
        });
        return ok(objectView(uploaded.current), requestId, 201);
      } catch (error) {
        return mapObjectError(error, requestId);
      }
    }
    return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
  }

  const objectId = segments[0]!;
  if (!objectId) {
    return apiError("NOT_FOUND", "Objek tidak ditemukan.", 404, requestId);
  }
  let bucket;
  try {
    bucket = ctx.bucketAccess.findById(userId, bucketId, "read");
  } catch {
    return apiError("ACCESS_DENIED", "Akses bucket ditolak.", 403, requestId);
  }
  if (!bucket) return apiError("NOT_FOUND", "Objek tidak ditemukan.", 404, requestId);
  const object = ctx.repos.objects.findActiveByIdInBucket(bucket.id, objectId);
  if (!object) return apiError("NOT_FOUND", "Objek tidak ditemukan.", 404, requestId);

  if (segments.length === 1 && req.method === "DELETE") {
    try {
      let writable;
      try {
        writable = ctx.bucketAccess.findById(userId, bucketId, "write");
      } catch {
        return apiError("ACCESS_DENIED", "Akses tulis bucket ditolak.", 403, requestId);
      }
      if (!writable) return apiError("NOT_FOUND", "Objek tidak ditemukan.", 404, requestId);
      await service.delete({
        actorUserId: userId,
        bucket: writable,
        object,
        reason: "dashboard_object_delete",
        signal: req.signal,
      });
      ctx.repos.audit.record({
        userId,
        action: "object.delete",
        bucketName: bucket.name,
        bucketId,
        objectKey: object.object_key,
        statusCode: 200,
        requestId,
      });
      return ok({ id: object.id, deleted: true }, requestId);
    } catch (error) {
      return mapObjectError(error, requestId);
    }
  }

  const action = segments[1];

  if (segments.length === 2 && action === "presigned-links" && req.method === "POST") {
    if (bucket.effective_role !== "owner") {
      return apiError("ACCESS_DENIED", "Hanya pemilik bucket dapat membuat public link.", 403, requestId);
    }
    try {
      await ctx.bucketAccess.verifyActorAccess(userId, bucket, false, req.signal);
    } catch {
      return apiError("ACCESS_DENIED", "Akses bucket ditolak.", 403, requestId);
    }
    const parsedBody = await readObjectJson<{ credentialId?: unknown; expiresSeconds?: unknown }>(
      ctx,
      req,
      requestId,
    );
    if (parsedBody.response) return parsedBody.response;
    const body = parsedBody.value;
    const credentialId = body?.credentialId;
    const expiresSeconds = body?.expiresSeconds;
    if (typeof credentialId !== "string" || typeof expiresSeconds !== "number") {
      return apiError("INVALID", "Credential dan masa berlaku wajib diisi.", 400, requestId);
    }
    try {
      const created = ctx.presignedUrlService.createGet({
        userId,
        credentialId,
        bucketName: bucket.name,
        object,
        expiresSeconds,
      });
      ctx.repos.audit.record({
        userId,
        credentialId,
        action: "object.presigned_link.create",
        bucketName: bucket.name,
        bucketId,
        objectKey: object.object_key,
        statusCode: 201,
        requestId,
        detail: { expiresAt: created.expiresAt },
      });
      const response = ok(created, requestId, 201);
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (error) {
      if (error instanceof PresignCredentialNotFoundError) {
        return apiError("NOT_FOUND", "Credential aktif tidak ditemukan.", 404, requestId);
      }
      if (error instanceof PresignExpiryError) {
        return apiError("INVALID", "Masa berlaku presigned link tidak valid.", 400, requestId);
      }
      throw error;
    }
  }

  if (action === "public-links" && bucket.effective_role !== "owner") {
    return apiError("ACCESS_DENIED", "Hanya pemilik bucket dapat mengelola public link.", 403, requestId);
  }
  if (action === "public-links") {
    try {
      await ctx.bucketAccess.verifyActorAccess(userId, bucket, false, req.signal);
    } catch {
      return apiError("ACCESS_DENIED", "Akses bucket ditolak.", 403, requestId);
    }
  }
  if (segments.length === 2 && action === "public-links" && req.method === "GET") {
    return ok(ctx.publicLinkService.list(userId, object.id), requestId);
  }
  if (segments.length === 2 && action === "public-links" && req.method === "POST") {
    const parsedBody = await readObjectJson<{ label?: unknown; expiresAt?: unknown }>(ctx, req, requestId);
    if (parsedBody.response) return parsedBody.response;
    const body = parsedBody.value;
    const label = body?.label;
    const expiresAt = body?.expiresAt;
    if (
      typeof label !== "string" ||
      (expiresAt !== undefined && expiresAt !== null && typeof expiresAt !== "string")
    ) {
      return apiError("INVALID", "Label atau masa berlaku public link tidak valid.", 400, requestId);
    }
    try {
      const created = ctx.publicLinkService.create({
        ownerUserId: userId,
        objectId: object.id,
        label,
        expiresAt: (expiresAt as string | null | undefined) ?? null,
      });
      ctx.repos.audit.record({
        userId,
        action: "object.public_link.create",
        bucketName: bucket.name,
        bucketId,
        objectKey: object.object_key,
        statusCode: 201,
        requestId,
        detail: { linkId: created.id, expiresAt: created.expiresAt },
      });
      const response = ok(created, requestId, 201);
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (error) {
      if (error instanceof TypeError) {
        return apiError("INVALID", "Public link tidak valid.", 400, requestId);
      }
      throw error;
    }
  }
  if (
    segments.length === 3 &&
    action === "public-links" &&
    req.method === "DELETE"
  ) {
    const linkId = segments[2]!;
    if (!ctx.publicLinkService.revoke(userId, object.id, linkId)) {
      return apiError("NOT_FOUND", "Public link tidak ditemukan.", 404, requestId);
    }
    ctx.repos.audit.record({
      userId,
      action: "object.public_link.revoke",
      bucketName: bucket.name,
      bucketId,
      objectKey: object.object_key,
      statusCode: 200,
      requestId,
      detail: { linkId },
    });
    return ok({ id: linkId, status: "revoked" }, requestId);
  }

  if (
    segments.length === 2 &&
    (action === "download" || action === "preview") &&
    (req.method === "GET" || req.method === "HEAD")
  ) {
    if (action === "preview" && !isPreviewableContentType(object.content_type)) {
      return apiError("PREVIEW_UNSUPPORTED", "Tipe file ini tidak aman untuk preview.", 415, requestId);
    }
    try {
      if (req.method === "HEAD") {
        try {
          await ctx.bucketAccess.verifyActorAccess(userId, bucket, false, req.signal);
        } catch {
          return apiError("ACCESS_DENIED", "Akses objek ditolak.", 403, requestId);
        }
        const current = ctx.repos.objects.findActiveByIdInBucket(bucket.id, object.id);
        if (!current || current.drive_file_id !== object.drive_file_id) {
          return apiError("NOT_FOUND", "Objek tidak ditemukan.", 404, requestId);
        }
        const headers = objectResponseHeaders(current, {
          contentLength: current.size_bytes,
          disposition: action === "preview" ? "inline" : "attachment",
        });
        headers.set("Cache-Control", "private, no-store");
        if (action === "preview") {
          headers.set(
            "Content-Security-Policy",
            "default-src 'none'; sandbox; media-src 'self'; img-src 'self'",
          );
        }
        return new Response(null, { status: 200, headers });
      }
      const downloaded = await service.download({
        actorUserId: userId,
        bucket,
        object,
        range: req.headers.get("range"),
        signal: req.signal,
      });
      const responseObject = ctx.repos.objects.findActiveByIdInBucket(bucket.id, object.id);
      if (!responseObject || responseObject.drive_file_id !== object.drive_file_id) {
        await downloaded.body?.cancel();
        return apiError("NOT_FOUND", "Objek tidak ditemukan.", 404, requestId);
      }
      const headers = objectResponseHeaders(responseObject, {
        contentLength: downloaded.contentLength,
        contentRange: downloaded.contentRange,
        disposition: action === "preview" ? "inline" : "attachment",
      });
      headers.set("Cache-Control", "private, no-store");
      if (action === "preview") {
        headers.set("Content-Security-Policy", "default-src 'none'; sandbox; media-src 'self'; img-src 'self'");
      }
      ctx.repos.audit.record({
        userId,
        action: action === "preview" ? "object.preview" : "object.download",
        bucketName: bucket.name,
        bucketId,
        objectKey: object.object_key,
        statusCode: downloaded.status,
        bytesOut: downloaded.contentLength,
        requestId,
      });
      return new Response(downloaded.body, { status: downloaded.status, headers });
    } catch (error) {
      return mapObjectError(error, requestId);
    }
  }

  return apiError("NOT_FOUND", "Endpoint tidak ditemukan.", 404, requestId);
}

async function list(
  ctx: AppContext,
  req: Request,
  userId: string,
  requestId: string,
  bucketId: string,
): Promise<Response> {
  let bucket;
  try {
    bucket = ctx.bucketAccess.findById(userId, bucketId, "read");
  } catch {
    return apiError("ACCESS_DENIED", "Akses bucket ditolak.", 403, requestId);
  }
  if (!bucket) return apiError("NOT_FOUND", "Bucket tidak ditemukan.", 404, requestId);
  try {
    await ctx.bucketAccess.verifyActorAccess(userId, bucket, false, req.signal);
  } catch {
    return apiError("ACCESS_DENIED", "Akses bucket ditolak.", 403, requestId);
  }
  const url = new URL(req.url);
  const prefix = url.searchParams.get("prefix") ?? "";
  const afterKey = url.searchParams.get("after") ?? "";
  const rawLimit = url.searchParams.get("limit") ?? "100";
  const parsedLimit = Number(rawLimit);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 1000) {
    return apiError("INVALID", "Limit harus antara 1 dan 1000.", 400, requestId);
  }
  const page = ctx.repos.objects.listByBucket(bucket.id, {
    prefix,
    afterKey,
    limit: parsedLimit,
  });
  return ok(
    {
      items: page.items.map(objectView),
      hasMore: page.hasMore,
      nextAfter: page.hasMore ? page.items[page.items.length - 1]?.object_key : null,
    },
    requestId,
  );
}

function objectView(object: import("../db/repositories/objects.ts").ObjectRow) {
  return {
    id: object.id,
    key: object.object_key,
    size: object.size_bytes,
    contentType: object.content_type,
    etag: object.etag,
    status: object.status,
    lastModified: object.last_modified_at,
  };
}

async function readObjectJson<T>(
  ctx: AppContext,
  req: Request,
  requestId: string,
): Promise<{ value: T | null; response: Response | null }> {
  try {
    return { value: await readJson<T>(ctx, req), response: null };
  } catch (error) {
    const mapped = mapBodyReadError(error, requestId);
    if (mapped) return { value: null, response: mapped };
    throw error;
  }
}

function parseDashboardMetadata(
  headers: Headers,
): import("../s3/metadata.ts").ObjectMetadataHeaders {
  const safeHeaders = new Headers();
  safeHeaders.set("Content-Type", headers.get("content-type") ?? "application/octet-stream");
  return parseObjectMetadata(safeHeaders);
}

function parseContentLength(value: string | null): number | null | "invalid" {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : "invalid";
}

function mapObjectError(error: unknown, requestId: string): Response {
  if (error instanceof ObjectAccessError) {
    return apiError("ACCESS_DENIED", "Akses objek ditolak.", 403, requestId);
  }
  if (error instanceof ObjectNotFoundError) {
    return apiError("NOT_FOUND", "Objek tidak ditemukan.", 404, requestId);
  }
  if (error instanceof S3Error) {
    if (error.code === "EntityTooLarge") {
      return apiError("PAYLOAD_TOO_LARGE", "File melebihi batas upload.", 413, requestId);
    }
    if (error.code === "InvalidRange") {
      const response = apiError("INVALID_RANGE", "Range tidak valid.", 416, requestId);
      if (error.details.ContentRange) response.headers.set("Content-Range", error.details.ContentRange);
      return response;
    }
    return apiError("INVALID", error.message, error.status, requestId);
  }
  return apiError("DRIVE_ERROR", "Operasi objek gagal.", 502, requestId);
}
