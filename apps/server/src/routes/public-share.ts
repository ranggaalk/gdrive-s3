import type { AppContext } from "../context.ts";
import type { ObjectRow } from "../db/repositories/objects.ts";
import type { AccessibleBucketRow } from "../db/repositories/buckets.ts";
import {
  ObjectAccessError,
  ObjectNotFoundError,
  ObjectService,
} from "../services/object-service.ts";
import { S3Error } from "../s3/errors.ts";
import { clientIpFrom, type HasRequestIp } from "../util/client-ip.ts";
import { retryAfterSeconds } from "../security/rate-limits.ts";
import { isPreviewableContentType, objectResponseHeaders } from "./object-http.ts";

export const PUBLIC_SHARE_PREFIX = "/__drives3_share/";

export async function handlePublicShare(
  ctx: AppContext,
  req: Request,
  requestId: string,
  server: HasRequestIp | null,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const decision = ctx.rateLimits.take("publicShare", clientIpFrom(req, server, ctx.config));
  if (!decision.allowed) {
    const response = Response.json({ error: "Too many requests" }, { status: 429 });
    response.headers.set("Retry-After", retryAfterSeconds(decision));
    return response;
  }
  const url = new URL(req.url);
  const token = url.pathname.slice(PUBLIC_SHARE_PREFIX.length);
  if (!token || token.includes("/")) return notFound();
  const resolved = ctx.publicLinkService.resolve(token);
  if (!resolved) return notFound();

  const bucket = resolvedBucket(resolved);
  const object = resolvedObject(resolved);
  try {
    const forceDownload = url.searchParams.get("download") === "1";
    const previewable = isPreviewableContentType(object.content_type);
    if (req.method === "HEAD") {
      try {
        await ctx.bucketAccess.verifyActorAccess(
          resolved.owner_user_id,
          bucket,
          false,
          req.signal,
        );
      } catch {
        throw new ObjectAccessError();
      }
      const current = ctx.repos.objects.findActiveByIdInBucket(bucket.id, object.id);
      if (!current || current.drive_file_id !== object.drive_file_id) {
        throw new ObjectNotFoundError();
      }
      const headers = objectResponseHeaders(current, {
        contentLength: current.size_bytes,
        disposition: !forceDownload && previewable ? "inline" : "attachment",
      });
      headers.set("Cache-Control", "private, no-store");
      headers.set("Cross-Origin-Resource-Policy", "cross-origin");
      return new Response(null, { status: 200, headers });
    }
    const downloaded = await new ObjectService(ctx).download({
      actorUserId: resolved.owner_user_id,
      bucket,
      object,
      range: req.headers.get("range"),
      signal: req.signal,
    });

    const headers = objectResponseHeaders(object, {
      contentLength: downloaded.contentLength,
      contentRange: downloaded.contentRange,
      disposition: !forceDownload && previewable ? "inline" : "attachment",
    });
    headers.set("Cache-Control", "private, no-store");
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    if (!forceDownload && previewable) {
      headers.set(
        "Content-Security-Policy",
        "default-src 'none'; sandbox; media-src 'self'; img-src 'self'",
      );
    }
    ctx.repos.publicObjectLinks.markAccessed(resolved.id);
    ctx.repos.audit.record({
      userId: resolved.owner_user_id,
      action: "public_link.access",
      bucketName: resolved.bucket_name,
      bucketId: bucket.id,
      objectKey: resolved.object_key,
      statusCode: downloaded.status,
      bytesOut: downloaded.contentLength,
      requestId,
      detail: { linkId: resolved.id },
    });
    return new Response(downloaded.body, { status: downloaded.status, headers });
  } catch (error) {
    if (
      !(error instanceof ObjectAccessError) &&
      !(error instanceof ObjectNotFoundError) &&
      !(error instanceof S3Error)
    ) {
      ctx.log.warn("public share download failed", {
        requestId,
        route: `${PUBLIC_SHARE_PREFIX}:token`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return notFound();
  }
}

export function maskedRoute(path: string): string {
  return path.startsWith(PUBLIC_SHARE_PREFIX) ? `${PUBLIC_SHARE_PREFIX}:token` : path;
}

function notFound(): Response {
  return new Response(null, {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
}

function resolvedBucket(
  row: import("../db/repositories/public-object-links.ts").ResolvedPublicObjectLink,
): AccessibleBucketRow {
  return {
    id: row.bucket_id,
    user_id: row.bucket_owner_id,
    name: row.bucket_name,
    region: row.bucket_region,
    drive_folder_id: row.drive_folder_id,
    drive_target_id: row.drive_target_id,
    status: row.bucket_status as AccessibleBucketRow["status"],
    // The signed link is the authorization here, not the ACL, so the
    // non-widening default is what belongs on this synthetic row.
    acl: "private",
    default_sse_algorithm: null,
    default_kms_key_id: null,
    versioning: "Disabled",
    created_at: "",
    updated_at: "",
    effective_role: "owner",
    storage_kind: row.storage_kind,
    storage_display_name: row.storage_display_name,
    storage_status: row.storage_status,
    shared_drive_id: row.shared_drive_id,
  };
}

function resolvedObject(
  row: import("../db/repositories/public-object-links.ts").ResolvedPublicObjectLink,
): ObjectRow {
  return {
    id: row.object_id,
    bucket_id: row.bucket_id,
    object_key: row.object_key,
    drive_file_id: row.drive_file_id,
    size_bytes: row.size_bytes,
    content_type: row.content_type,
    etag: row.etag,
    checksum_sha256: null,
    storage_class: "STANDARD",
    status: "active",
    metadata_json: row.metadata_json,
    cache_control: row.cache_control,
    content_disposition: row.content_disposition,
    content_encoding: row.content_encoding,
    content_language: row.content_language,
    expires_at: row.object_expires_at,
    acl: "private",
    version_id: "null",
    last_modified_at: row.last_modified_at,
    created_at: row.object_created_at,
    updated_at: row.object_updated_at,
  };
}
