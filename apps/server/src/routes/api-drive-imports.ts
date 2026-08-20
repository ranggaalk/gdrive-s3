import type { AppContext } from "../context.ts";
import type { SessionRow } from "../db/repositories/sessions.ts";
import type { DriveImportJobRow } from "../db/repositories/drive-imports.ts";
import type { DriveOperationTarget } from "../drive/storage.ts";
import {
  DriveImportAlreadyExistsError,
  DriveImportInvalidSourceError,
  DriveImportService,
} from "../services/drive-import-service.ts";
import { apiError, mapBodyReadError, ok, readJson } from "./api-helpers.ts";

export async function handleDriveFolders(
  ctx: AppContext,
  req: Request,
  session: SessionRow,
  requestId: string,
): Promise<Response> {
  if (req.method !== "GET") {
    return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
  }
  const query = new URL(req.url).searchParams;
  const kind = query.get("kind") ?? "my_drive";
  const driveId = query.get("driveId") ?? undefined;
  const parentId = query.get("parentId") ?? (kind === "shared_drive" ? driveId : "root");
  const pageToken = query.get("pageToken") ?? undefined;
  if ((kind !== "my_drive" && kind !== "shared_drive") || !parentId) {
    return apiError("INVALID", "Target atau folder Drive tidak valid.", 400, requestId);
  }
  let target: DriveOperationTarget;
  if (kind === "shared_drive") {
    if (!driveId) return apiError("INVALID", "Shared Drive wajib dipilih.", 400, requestId);
    target = { kind, driveId };
  } else {
    target = { kind };
  }
  try {
    const page = await ctx.driveStorage.listChildren({
      userId: session.user_id,
      parentId,
      pageToken,
      pageSize: Math.min(ctx.config.driveImportPageSize, 200),
      foldersOnly: true,
      target,
      signal: req.signal,
    });
    const current = await ctx.driveStorage.getSourceItem({
      userId: session.user_id,
      fileId: parentId,
      target,
      signal: req.signal,
    });
    return ok(
      {
        current: current ? { id: current.id, name: current.name } : null,
        items: page.items.map((item) => ({ id: item.id, name: item.name })),
        nextPageToken: page.nextPageToken,
      },
      requestId,
    );
  } catch {
    return apiError("DRIVE_ERROR", "Gagal memuat folder Google Drive.", 502, requestId);
  }
}

export async function handleBucketImports(
  ctx: AppContext,
  req: Request,
  session: SessionRow,
  requestId: string,
  bucketId: string,
  segments: string[],
): Promise<Response> {
  const owner = ownerBucket(ctx, session.user_id, bucketId);
  if (!owner) return apiError("ACCESS_DENIED", "Hanya pemilik bucket yang dapat mengimpor.", 403, requestId);

  if (segments.length === 0) {
    if (req.method === "GET") {
      return ok(
        ctx.repos.driveImports.listOwned(session.user_id, bucketId).map(jobView),
        requestId,
      );
    }
    if (req.method === "POST") {
      let body: {
        sourceKind?: "my_drive" | "shared_drive";
        sourceDriveId?: string;
        sourceFolderId?: string;
      } | null;
      try {
        body = await readJson<{
          sourceKind?: "my_drive" | "shared_drive";
          sourceDriveId?: string;
          sourceFolderId?: string;
        }>(ctx, req);
      } catch (error) {
        const mapped = mapBodyReadError(error, requestId);
        if (mapped) return mapped;
        throw error;
      }
      if (
        !body?.sourceFolderId ||
        (body.sourceKind !== "my_drive" && body.sourceKind !== "shared_drive") ||
        (body.sourceKind === "shared_drive" && !body.sourceDriveId) ||
        (body.sourceKind === "my_drive" && body.sourceDriveId !== undefined)
      ) {
        return apiError("INVALID", "Folder dan target sumber wajib dipilih.", 400, requestId);
      }
      try {
        const job = await new DriveImportService(ctx).create({
          userId: session.user_id,
          bucketId,
          sourceKind: body.sourceKind,
          sourceDriveId: body.sourceDriveId,
          sourceFolderId: body.sourceFolderId,
          signal: req.signal,
        });
        ctx.repos.audit.record({
          userId: session.user_id,
          action: "drive.import.create",
          bucketName: owner.name,
          statusCode: 202,
          requestId,
          detail: { importJobId: job.id },
        });
        return ok(jobView(job), requestId, 202);
      } catch (error) {
        if (error instanceof DriveImportInvalidSourceError) {
          return apiError("INVALID_SOURCE", "Folder sumber tidak dapat digunakan.", 400, requestId);
        }
        if (error instanceof DriveImportAlreadyExistsError) {
          return apiError("IMPORT_ACTIVE", "Masih ada import aktif untuk bucket ini.", 409, requestId);
        }
        throw error;
      }
    }
    return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
  }

  const jobId = segments[0]!;
  const job = ctx.repos.driveImports.findOwned(session.user_id, bucketId, jobId);
  if (!job) return apiError("NOT_FOUND", "Import tidak ditemukan.", 404, requestId);
  if (segments.length === 1 && req.method === "GET") return ok(jobView(job), requestId);
  if (segments[1] === "items" && segments.length === 2 && req.method === "GET") {
    const query = new URL(req.url).searchParams;
    const afterId = query.get("after") ?? undefined;
    const limit = Math.min(Math.max(Number(query.get("limit") ?? "100") || 100, 1), 500);
    const page = ctx.repos.driveImports.listItems(session.user_id, bucketId, jobId, {
      afterId,
      limit,
    });
    return ok(
      {
        items: page.items.map((item) => ({
          id: item.id,
          key: item.object_key,
          name: item.source_name,
          status: item.status,
          reason: item.reason,
        })),
        hasMore: page.hasMore,
        nextAfter: page.hasMore ? page.items.at(-1)?.id ?? null : null,
      },
      requestId,
    );
  }
  if (segments[1] === "cancel" && segments.length === 2 && req.method === "POST") {
    const changed = ctx.repos.driveImports.requestCancel(session.user_id, bucketId, jobId);
    if (!changed) return apiError("IMPORT_TERMINAL", "Import sudah selesai.", 409, requestId);
    return ok({ cancelled: true }, requestId);
  }
  return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
}

function ownerBucket(ctx: AppContext, userId: string, bucketId: string) {
  try {
    return ctx.bucketAccess.findById(userId, bucketId, "owner");
  } catch {
    return null;
  }
}

function jobView(job: DriveImportJobRow) {
  return {
    id: job.id,
    bucketId: job.bucket_id,
    sourceFolderId: job.source_folder_id,
    sourceFolderName: job.source_folder_name,
    sourceKind: job.source_kind,
    sourceDriveId: job.source_drive_id,
    phase: job.phase,
    status: job.status,
    discovered: job.discovered_count,
    imported: job.imported_count,
    conflicts: job.conflict_count,
    unsupported: job.unsupported_count,
    failed: job.failed_count,
    lastError: job.last_error,
    createdAt: job.created_at,
    completedAt: job.completed_at,
  };
}
