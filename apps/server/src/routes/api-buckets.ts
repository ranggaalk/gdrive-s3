// /api/buckets — list/create, get/delete, and nested object listing.

import type { AppContext } from "../context.ts";
import type { SessionRow } from "../db/repositories/sessions.ts";
import { apiError, mapBodyReadError, ok, readJson } from "./api-helpers.ts";
import {
  BucketAlreadyOwnedError,
  BucketNotEmptyError,
  BucketNotFoundError,
  SharedDriveNotFoundError,
  type BucketStorageSelection,
} from "../services/bucket-service.ts";
import {
  BucketAccessDeniedError,
  BucketMemberNotFoundError,
  BucketNamespaceConflictError,
} from "../services/bucket-access-service.ts";
import type { BucketMemberRole } from "../db/repositories/bucket-members.ts";
import { InvalidBucketNameError } from "../util/bucket-name.ts";
import { handleObjects } from "./api-objects.ts";
import { handleBucketImports } from "./api-drive-imports.ts";
import { handleBucketBackups } from "./api-backup.ts";
import { resolveTrafficWindow } from "./traffic-range.ts";

function bucketView(b: {
  id: string;
  name: string;
  region: string;
  status: string;
  created_at: string;
  effective_role?: string;
  storage_kind?: string;
  storage_display_name?: string;
  storage_status?: string;
}) {
  return {
    id: b.id,
    name: b.name,
    region: b.region,
    status: b.status,
    createdAt: b.created_at,
    effectiveRole: b.effective_role ?? "owner",
    ownedByMe: (b.effective_role ?? "owner") === "owner",
    storageKind: b.storage_kind ?? "my_drive",
    storageDisplayName: b.storage_display_name ?? "My Drive",
    storageStatus: b.storage_status ?? "active",
  };
}

export async function handleBuckets(
  ctx: AppContext,
  req: Request,
  session: SessionRow,
  requestId: string,
  rest: string, // path after /api/buckets
): Promise<Response> {
  const userId = session.user_id;

  // Collection
  if (rest === "" || rest === "/") {
    if (req.method === "GET") {
      const rows = ctx.bucketAccess.list(userId);
      const withCounts = rows.map((b) => ({
        ...bucketView(b),
        objectCount: ctx.repos.objects.countActive(b.id),
        multipartOpen: ctx.repos.multipartUploads.countOpenByBucket(b.id),
      }));
      return ok(withCounts, requestId);
    }
    if (req.method === "POST") {
      let body: {
        name?: string;
        storage?: { kind?: "my_drive" | "shared_drive"; driveId?: string };
      } | null;
      try {
        body = await readJson<{
          name?: string;
          storage?: { kind?: "my_drive" | "shared_drive"; driveId?: string };
        }>(ctx, req);
      } catch (err) {
        const mapped = mapBodyReadError(err, requestId);
        if (mapped) return mapped;
        throw err;
      }
      if (!body?.name) return apiError("INVALID", "Nama bucket wajib diisi.", 400, requestId);
      let storage: BucketStorageSelection = { kind: "my_drive" };
      if (body.storage?.kind === "shared_drive") {
        if (!body.storage.driveId) {
          return apiError("INVALID", "Shared Drive wajib dipilih.", 400, requestId);
        }
        storage = { kind: "shared_drive", driveId: body.storage.driveId };
      }
      try {
        if (ctx.repos.buckets.hasAccessibleName(userId, body.name)) {
          return apiError("BUCKET_ALREADY_OWNED", "Nama bucket sudah ada di namespace Anda.", 409, requestId);
        }
        const bucket = await ctx.bucketService.create(userId, body.name, undefined, storage);
        ctx.repos.audit.record({
          userId,
          action: "bucket.create",
          bucketName: bucket.name,
          bucketId: bucket.id,
          statusCode: 201,
          requestId,
        });
        const accessible = ctx.bucketAccess.findById(userId, bucket.id, "read");
        return ok(bucketView(accessible ?? bucket), requestId, 201);
      } catch (err) {
        return mapBucketError(err, requestId);
      }
    }
    return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
  }

  // /:id, /:id/objects, or owner-only /:id/members
  const segments = rest.replace(/^\//, "").split("/");
  const bucketId = segments[0]!;
  if (!bucketId) return apiError("NOT_FOUND", "Bucket tidak ditemukan.", 404, requestId);

  if (segments[1] === "members") {
    try {
      if (segments.length === 2 && req.method === "GET") {
        return ok(ctx.bucketAccess.listMembers(userId, bucketId), requestId);
      }
      if (segments.length === 2 && req.method === "POST") {
        let body: { email?: string; role?: BucketMemberRole } | null;
        try {
          body = await readJson<{ email?: string; role?: BucketMemberRole }>(ctx, req);
        } catch (error) {
          const mapped = mapBodyReadError(error, requestId);
          if (mapped) return mapped;
          throw error;
        }
        if (!body?.email || (body.role !== "viewer" && body.role !== "editor")) {
          return apiError("INVALID", "Email dan role anggota wajib diisi.", 400, requestId);
        }
        const owner = ctx.repos.users.findById(userId);
        if (!owner) return apiError("NOT_FOUND", "User tidak ditemukan.", 404, requestId);
        const member = await ctx.bucketAccess.addMember({
          ownerUserId: userId,
          bucketId,
          email: body.email,
          role: body.role,
          hostedDomain: owner.hosted_domain,
          signal: req.signal,
        });
        return ok(member, requestId, 201);
      }
      const memberUserId = segments[2];
      if (segments.length === 3 && memberUserId && req.method === "PATCH") {
        let body: { role?: BucketMemberRole } | null;
        try {
          body = await readJson<{ role?: BucketMemberRole }>(ctx, req);
        } catch (error) {
          const mapped = mapBodyReadError(error, requestId);
          if (mapped) return mapped;
          throw error;
        }
        if (body?.role !== "viewer" && body?.role !== "editor") {
          return apiError("INVALID", "Role anggota tidak valid.", 400, requestId);
        }
        if (
          !(await ctx.bucketAccess.updateMember(
            userId,
            bucketId,
            memberUserId,
            body.role,
            req.signal,
          ))
        ) {
          return apiError("NOT_FOUND", "Anggota tidak ditemukan.", 404, requestId);
        }
        return ok({ userId: memberUserId, role: body.role }, requestId);
      }
      if (segments.length === 3 && memberUserId && req.method === "DELETE") {
        if (!ctx.bucketAccess.removeMember(userId, bucketId, memberUserId)) {
          return apiError("NOT_FOUND", "Anggota tidak ditemukan.", 404, requestId);
        }
        return ok({ userId: memberUserId, removed: true }, requestId);
      }
      return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
    } catch (err) {
      return mapBucketError(err, requestId);
    }
  }

  if (segments[1] === "imports") {
    const importSegments = segments.slice(2).filter(Boolean);
    return handleBucketImports(ctx, req, session, requestId, bucketId, importSegments);
  }

  if (segments[1] === "backups") {
    const backupSegments = segments.slice(2).filter(Boolean);
    return handleBucketBackups(ctx, req, session, requestId, bucketId, backupSegments);
  }

  if (segments[1] === "objects") {
    const objectSegments = segments.slice(2);
    if (objectSegments.length === 1 && objectSegments[0] === "") {
      objectSegments.length = 0;
    }
    return handleObjects(ctx, req, session, requestId, bucketId, objectSegments);
  }

  if (segments[1] === "traffic") {
    if (req.method !== "GET") return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
    const bucket = ctx.bucketAccess.findById(userId, bucketId, "read");
    if (!bucket) return apiError("NOT_FOUND", "Bucket tidak ditemukan.", 404, requestId);
    const range = new URL(req.url).searchParams.get("range") ?? "1h";
    const window = resolveTrafficWindow(range);
    if (!window) return apiError("INVALID", "range harus salah satu dari: 1h, 24h, 7d.", 400, requestId);
    const since = new Date(Date.now() - window.windowMs);
    const points = ctx.repos.audit.trafficSeries(bucket.id, since, window.granularity);
    return ok({ range, granularity: window.granularity, points }, requestId);
  }

  if (segments.length === 1) {
    if (req.method === "GET") {
      const bucket = ctx.bucketAccess.findById(userId, bucketId, "read");
      if (!bucket) return apiError("NOT_FOUND", "Bucket tidak ditemukan.", 404, requestId);
      return ok(
        {
          ...bucketView(bucket),
          objectCount: ctx.repos.objects.countActive(bucket.id),
          multipartOpen: ctx.repos.multipartUploads.countOpenByBucket(bucket.id),
        },
        requestId,
      );
    }
    if (req.method === "DELETE") {
      try {
        const bucket = ctx.bucketAccess.findById(userId, bucketId, "owner");
        if (!bucket) return apiError("NOT_FOUND", "Bucket tidak ditemukan.", 404, requestId);
        await ctx.bucketService.delete(userId, bucketId);
        ctx.repos.audit.record({
          userId,
          action: "bucket.delete",
          bucketName: bucketId,
          // No bucketId here: the row is already gone by this point (FK
          // would reject a reference to a bucket that no longer exists).
          statusCode: 200,
          requestId,
        });
        return ok({ id: bucketId, deleted: true }, requestId);
      } catch (err) {
        return mapBucketError(err, requestId);
      }
    }
    return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
  }

  return apiError("NOT_FOUND", "Endpoint tidak ditemukan.", 404, requestId);
}

function mapBucketError(err: unknown, requestId: string): Response {
  if (err instanceof InvalidBucketNameError) {
    return apiError("INVALID_BUCKET_NAME", "Nama bucket tidak valid.", 400, requestId);
  }
  if (err instanceof BucketAlreadyOwnedError) {
    return apiError("BUCKET_ALREADY_OWNED", "Bucket sudah ada.", 409, requestId);
  }
  if (err instanceof BucketNotEmptyError) {
    return apiError("BUCKET_NOT_EMPTY", "Bucket tidak kosong.", 409, requestId);
  }
  if (err instanceof BucketNotFoundError || err instanceof BucketMemberNotFoundError) {
    return apiError("NOT_FOUND", "Bucket atau anggota tidak ditemukan.", 404, requestId);
  }
  if (err instanceof SharedDriveNotFoundError) {
    return apiError(
      "SHARED_DRIVE_NOT_WRITABLE",
      "Shared Drive tidak tersedia atau tidak dapat ditulisi.",
      409,
      requestId,
    );
  }
  if (err instanceof BucketNamespaceConflictError) {
    return apiError(
      "BUCKET_NAMESPACE_CONFLICT",
      "Nama bucket bertabrakan dengan namespace anggota.",
      409,
      requestId,
    );
  }
  if (err instanceof BucketAccessDeniedError) {
    return apiError("ACCESS_DENIED", "Akses bucket ditolak.", 403, requestId);
  }
  return apiError("DRIVE_ERROR", "Operasi Drive gagal.", 502, requestId);
}
