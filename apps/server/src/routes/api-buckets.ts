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
import {
  PresignCredentialNotFoundError,
  PresignExpiryError,
  PresignPostInputError,
} from "../services/presigned-url-service.ts";
import { isBucketAcl } from "../s3/acl.ts";
import { parseBucketPolicy } from "../s3/policy.ts";
import { S3Error } from "../s3/errors.ts";
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
        // Surfaced in the list so an accidentally public bucket is visible
        // without opening anything.
        isPublic: ctx.authorization.isPublic(b),
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

  if (segments[1] === "presigned-post" && segments.length === 2) {
    if (req.method !== "POST") {
      return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
    }
    const bucket = ctx.bucketAccess.findById(userId, bucketId, "write");
    if (!bucket) return apiError("NOT_FOUND", "Bucket tidak ditemukan.", 404, requestId);
    try {
      await ctx.bucketAccess.verifyActorAccess(userId, bucket, true, req.signal);
    } catch {
      return apiError("ACCESS_DENIED", "Akses bucket ditolak.", 403, requestId);
    }

    let body;
    try {
      body = await readJson<{
        credentialId?: unknown;
        keyPrefix?: unknown;
        expiresSeconds?: unknown;
        maxBytes?: unknown;
      }>(ctx, req);
    } catch (error) {
      const mapped = mapBodyReadError(error, requestId);
      if (mapped) return mapped;
      throw error;
    }
    const credentialId = body?.credentialId;
    const keyPrefix = body?.keyPrefix ?? "";
    const expiresSeconds = body?.expiresSeconds;
    const maxBytes = body?.maxBytes;
    if (
      typeof credentialId !== "string" ||
      typeof keyPrefix !== "string" ||
      typeof expiresSeconds !== "number" ||
      typeof maxBytes !== "number"
    ) {
      return apiError("INVALID", "Credential, masa berlaku, dan batas ukuran wajib diisi.", 400, requestId);
    }

    try {
      const created = ctx.presignedUrlService.createPost({
        userId,
        credentialId,
        bucketName: bucket.name,
        keyPrefix,
        expiresSeconds,
        maxBytes,
      });
      ctx.repos.audit.record({
        userId,
        credentialId,
        action: "bucket.presigned_post.create",
        bucketName: bucket.name,
        bucketId: bucket.id,
        statusCode: 201,
        requestId,
        detail: { keyPrefix, expiresAt: created.expiresAt, maxBytes },
      });
      // The signature is a bearer credential for the upload; keep it out of
      // any intermediary cache.
      const response = ok(created, requestId, 201);
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (error) {
      if (error instanceof PresignCredentialNotFoundError) {
        return apiError("NOT_FOUND", "Credential aktif tidak ditemukan.", 404, requestId);
      }
      if (error instanceof PresignExpiryError) {
        return apiError("INVALID", "Masa berlaku presigned form tidak valid.", 400, requestId);
      }
      if (error instanceof PresignPostInputError) {
        return apiError("INVALID", error.message, 400, requestId);
      }
      throw error;
    }
  }

  // Access configuration is owner-only, matching the S3 data plane: a policy
  // must never be able to grant away control of the policy itself.
  if (segments[1] === "access" && segments.length === 2) {
    const bucket = ctx.bucketAccess.findById(userId, bucketId, "owner");
    if (!bucket) return apiError("NOT_FOUND", "Bucket tidak ditemukan.", 404, requestId);

    if (req.method === "GET") {
      const policyRow = ctx.repos.bucketPolicies.find(bucket.id);
      return ok(
        {
          acl: bucket.acl,
          policy: policyRow?.policy_json ?? null,
          policyUpdatedAt: policyRow?.updated_at ?? null,
          isPublic: ctx.authorization.isPublic(bucket),
          defaultSseAlgorithm: bucket.default_sse_algorithm,
          defaultKmsKeyId: bucket.default_kms_key_id,
          versioning: bucket.versioning,
          retainedVersions: ctx.repos.objectVersions.countForBucket(bucket.id),
          objectLockEnabled: !!bucket.object_lock_enabled,
          objectLockDefault: bucket.object_lock_default_json
            ? (JSON.parse(bucket.object_lock_default_json) as unknown)
            : null,
        },
        requestId,
      );
    }

    if (req.method === "PUT") {
      let body;
      try {
        body = await readJson<{
          acl?: unknown;
          policy?: unknown;
          defaultSseAlgorithm?: unknown;
          defaultKmsKeyId?: unknown;
          versioning?: unknown;
          objectLockEnabled?: unknown;
          objectLockDefault?: unknown;
        }>(ctx, req);
      } catch (error) {
        const mapped = mapBodyReadError(error, requestId);
        if (mapped) return mapped;
        throw error;
      }

      if (body?.acl !== undefined) {
        if (typeof body.acl !== "string" || !isBucketAcl(body.acl)) {
          return apiError("INVALID", "Canned ACL tidak valid.", 400, requestId);
        }
        ctx.repos.buckets.setAcl(bucket.id, body.acl);
        ctx.repos.audit.record({
          userId,
          action: "bucket.acl.update",
          bucketName: bucket.name,
          bucketId: bucket.id,
          statusCode: 200,
          requestId,
          detail: { acl: body.acl },
        });
      }

      // null clears the policy; a string replaces it. Absent leaves it alone,
      // so the ACL can be changed without touching the policy.
      if (body?.policy !== undefined) {
        if (body.policy === null) {
          ctx.repos.bucketPolicies.delete(bucket.id);
          ctx.repos.audit.record({
            userId,
            action: "bucket.policy.delete",
            bucketName: bucket.name,
            bucketId: bucket.id,
            statusCode: 200,
            requestId,
          });
        } else if (typeof body.policy === "string") {
          try {
            // Validate before storing: an unparseable document would behave as
            // "no policy" and silently protect nothing.
            const parsed = parseBucketPolicy(body.policy);
            ctx.repos.bucketPolicies.put({
              bucketId: bucket.id,
              policyJson: body.policy,
              updatedBy: userId,
            });
            ctx.repos.audit.record({
              userId,
              action: "bucket.policy.update",
              bucketName: bucket.name,
              bucketId: bucket.id,
              statusCode: 200,
              requestId,
              detail: { statements: parsed.statements.length },
            });
          } catch (error) {
            if (error instanceof S3Error) {
              return apiError("INVALID", error.details["Reason"] ?? error.message, 400, requestId);
            }
            throw error;
          }
        } else {
          return apiError("INVALID", "Policy harus berupa string JSON atau null.", 400, requestId);
        }
      }

      // Object Lock is one-way: enabling it also turns versioning on, and
      // there is deliberately no path back. A retention guarantee that can be
      // switched off is not a guarantee.
      if (body?.objectLockEnabled === true && !bucket.object_lock_enabled) {
        ctx.repos.buckets.enableObjectLock(bucket.id);
        ctx.repos.audit.record({
          userId,
          action: "bucket.object_lock.enable",
          bucketName: bucket.name,
          bucketId: bucket.id,
          statusCode: 200,
          requestId,
        });
      }

      if (body?.objectLockDefault !== undefined) {
        const value = body.objectLockDefault;
        if (value === null) {
          ctx.repos.buckets.setObjectLockDefault(bucket.id, null);
        } else if (
          typeof value === "object" &&
          typeof (value as { mode?: unknown }).mode === "string" &&
          typeof (value as { days?: unknown }).days === "number"
        ) {
          const { mode, days } = value as { mode: string; days: number };
          if ((mode !== "GOVERNANCE" && mode !== "COMPLIANCE") || !(days > 0)) {
            return apiError("INVALID", "Default retention tidak valid.", 400, requestId);
          }
          if (!ctx.bucketAccess.findById(userId, bucketId, "owner")?.object_lock_enabled) {
            return apiError("INVALID", "Aktifkan Object Lock terlebih dahulu.", 400, requestId);
          }
          ctx.repos.buckets.setObjectLockDefault(bucket.id, JSON.stringify({ mode, days }));
        } else {
          return apiError("INVALID", "Default retention tidak valid.", 400, requestId);
        }
        ctx.repos.audit.record({
          userId,
          action: "bucket.object_lock.default",
          bucketName: bucket.name,
          bucketId: bucket.id,
          statusCode: 200,
          requestId,
        });
      }

      // Versioning. Once on, S3 has no way back to Disabled — Suspended is
      // the off switch, and it keeps existing versions.
      if (body?.versioning !== undefined) {
        const versioning = body.versioning;
        if (versioning !== "Enabled" && versioning !== "Suspended") {
          return apiError("INVALID", "Versioning harus Enabled atau Suspended.", 400, requestId);
        }
        ctx.repos.buckets.setVersioning(bucket.id, versioning);
        ctx.repos.audit.record({
          userId,
          action: "bucket.versioning.update",
          bucketName: bucket.name,
          bucketId: bucket.id,
          statusCode: 200,
          requestId,
          detail: { versioning },
        });
      }

      // Default encryption. null clears it; absent leaves it alone.
      if (body?.defaultSseAlgorithm !== undefined) {
        const algorithm = body.defaultSseAlgorithm;
        if (algorithm === null) {
          ctx.repos.buckets.setDefaultEncryption(bucket.id, null, null);
        } else if (algorithm === "AES256" || algorithm === "aws:kms") {
          let kmsKeyId: string | null = null;
          if (algorithm === "aws:kms") {
            const keyRef = body.defaultKmsKeyId;
            if (typeof keyRef !== "string" || !keyRef) {
              return apiError("INVALID", "aws:kms memerlukan KMS key.", 400, requestId);
            }
            // Resolved now so a broken default fails here rather than on every
            // later upload.
            const found = ctx.repos.kmsKeys.findOwned(bucket.user_id, keyRef);
            if (!found) return apiError("NOT_FOUND", "KMS key tidak ditemukan.", 404, requestId);
            kmsKeyId = found.id;
          }
          ctx.repos.buckets.setDefaultEncryption(bucket.id, algorithm, kmsKeyId);
        } else {
          return apiError("INVALID", "Algoritma enkripsi tidak valid.", 400, requestId);
        }
        ctx.repos.audit.record({
          userId,
          action: "bucket.encryption.update",
          bucketName: bucket.name,
          bucketId: bucket.id,
          statusCode: 200,
          requestId,
          detail: { algorithm: algorithm ?? null },
        });
      }

      const updated = ctx.bucketAccess.findById(userId, bucketId, "owner")!;
      const policyRow = ctx.repos.bucketPolicies.find(bucket.id);
      return ok(
        {
          acl: updated.acl,
          policy: policyRow?.policy_json ?? null,
          policyUpdatedAt: policyRow?.updated_at ?? null,
          isPublic: ctx.authorization.isPublic(updated),
          defaultSseAlgorithm: updated.default_sse_algorithm,
          defaultKmsKeyId: updated.default_kms_key_id,
          versioning: updated.versioning,
          retainedVersions: ctx.repos.objectVersions.countForBucket(updated.id),
          objectLockEnabled: !!updated.object_lock_enabled,
          objectLockDefault: updated.object_lock_default_json
            ? (JSON.parse(updated.object_lock_default_json) as unknown)
            : null,
        },
        requestId,
      );
    }

    return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
  }

  if (segments[1] === "versions" && segments.length === 2 && req.method === "DELETE") {
    const bucket = ctx.bucketAccess.findById(userId, bucketId, "owner");
    if (!bucket) return apiError("NOT_FOUND", "Bucket tidak ditemukan.", 404, requestId);

    // Retained versions keep Drive files alive, so an operator needs a way to
    // reclaim that space without deleting them one by one.
    const stale = ctx.repos.objectVersions.listNonCurrent(bucket.id);
    for (const version of stale) {
      if (version.drive_file_id) {
        ctx.repos.pendingCleanup.enqueue({
          userId: bucket.user_id,
          resourceType: "drive_file",
          resourceId: version.drive_file_id,
          reason: "version_prune",
          driveTargetId: bucket.drive_target_id,
        });
      }
      ctx.repos.objectVersions.delete(bucket.id, version.object_key, version.version_id);
    }
    ctx.repos.audit.record({
      userId,
      action: "bucket.versions.prune",
      bucketName: bucket.name,
      bucketId: bucket.id,
      statusCode: 200,
      requestId,
      detail: { removed: stale.length },
    });
    return ok({ removed: stale.length }, requestId);
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
