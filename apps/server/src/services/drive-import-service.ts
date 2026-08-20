import type { AccessibleBucketRow } from "../db/repositories/buckets.ts";
import type {
  DiscoveredImportItem,
  DriveImportItemRow,
  DriveImportJobRow,
  DriveImportSourceKind,
} from "../db/repositories/drive-imports.ts";
import type { DriveOperationTarget, DriveSourceItem } from "../drive/storage.ts";
import {
  DRIVE_FOLDER_MIME,
  importFolderPath,
  importObjectKey,
  unsupportedImportReason,
} from "../drive/import-path.ts";
import type { AppContext } from "../context.ts";
import {
  ObjectAlreadyExistsError,
  ObjectService,
} from "./object-service.ts";

export class DriveImportInvalidSourceError extends Error {}
export class DriveImportAlreadyExistsError extends Error {}

export class DriveImportService {
  constructor(private readonly ctx: AppContext) {}

  async create(input: {
    userId: string;
    bucketId: string;
    sourceKind: DriveImportSourceKind;
    sourceDriveId?: string;
    sourceFolderId: string;
    signal?: AbortSignal;
  }): Promise<DriveImportJobRow> {
    let bucket: AccessibleBucketRow | null;
    try {
      bucket = this.ctx.bucketAccess.findById(input.userId, input.bucketId, "owner");
    } catch {
      bucket = null;
    }
    if (!bucket) throw new DriveImportInvalidSourceError("bucket not found");
    const target = sourceTarget(input.sourceKind, input.sourceDriveId);
    if (input.sourceFolderId === bucket.drive_folder_id) {
      throw new DriveImportInvalidSourceError("source is the destination bucket folder");
    }
    if (target.kind === "shared_drive") {
      const drive = await this.ctx.driveStorage.validateSharedDrive({
        userId: input.userId,
        driveId: target.driveId,
        signal: input.signal,
      });
      if (!drive?.canDownload) throw new DriveImportInvalidSourceError("shared drive unavailable");
    }
    const folder = await this.ctx.driveStorage.getSourceItem({
      userId: input.userId,
      fileId: input.sourceFolderId,
      target,
      signal: input.signal,
    });
    if (!folder || folder.trashed || folder.mimeType !== DRIVE_FOLDER_MIME) {
      throw new DriveImportInvalidSourceError("source folder unavailable");
    }
    try {
      return this.ctx.repos.driveImports.create({
        userId: input.userId,
        bucketId: input.bucketId,
        sourceKind: input.sourceKind,
        sourceDriveId: input.sourceDriveId,
        sourceFolderId: input.sourceFolderId,
        sourceFolderName: folder.name,
      });
    } catch (error) {
      if (String(error).includes("idx_drive_import_one_active_bucket")) {
        throw new DriveImportAlreadyExistsError();
      }
      throw error;
    }
  }

  async process(job: DriveImportJobRow, signal?: AbortSignal): Promise<void> {
    if (job.status === "cancel_requested") {
      this.ctx.repos.driveImports.refreshAndMaybeFinish(job.id);
      return;
    }
    if (job.phase === "scan") {
      await this.scanPage(job, signal);
      return;
    }
    await this.copyBatch(job, signal);
  }

  private async scanPage(job: DriveImportJobRow, signal?: AbortSignal): Promise<void> {
    const folder = this.ctx.repos.driveImports.nextFolder(job.id);
    if (!folder) {
      this.ctx.repos.driveImports.finalizeScan(job.id);
      this.ctx.repos.driveImports.refreshAndMaybeFinish(job.id);
      return;
    }
    const target = sourceTarget(job.source_kind, job.source_drive_id ?? undefined);
    const page = await this.ctx.driveStorage.listChildren({
      userId: job.user_id,
      parentId: folder.source_folder_id,
      pageSize: this.ctx.config.driveImportPageSize,
      pageToken: folder.next_page_token ?? undefined,
      target,
      signal,
    });
    const folders: Array<{ sourceFolderId: string; relativePath: string }> = [];
    const items: DiscoveredImportItem[] = [];
    for (const item of page.items) {
      if (item.appProperties.drives3Type) continue;
      if (item.mimeType === DRIVE_FOLDER_MIME) {
        try {
          folders.push({
            sourceFolderId: item.id,
            relativePath: importFolderPath(folder.relative_path, item.name),
          });
        } catch {
          // A child below an overlong folder cannot produce a valid S3 key.
        }
        continue;
      }
      let objectKey: string;
      try {
        objectKey = importObjectKey(folder.relative_path, item.name);
      } catch {
        objectKey = `${folder.relative_path}/${item.name}`;
        items.push(discovered(item, objectKey, "unsupported", "object_key_too_long"));
        continue;
      }
      const reason = unsupportedImportReason(item);
      items.push(discovered(item, objectKey, reason ? "unsupported" : "pending", reason ?? undefined));
    }
    this.ctx.repos.driveImports.saveFolderPage({
      jobId: job.id,
      folderId: folder.id,
      folders,
      items,
      nextPageToken: page.nextPageToken,
    });
  }

  private async copyBatch(job: DriveImportJobRow, signal?: AbortSignal): Promise<void> {
    const bucket = this.ctx.bucketAccess.findById(job.user_id, job.bucket_id, "owner");
    if (!bucket) throw new Error("import destination bucket is unavailable");
    const target = sourceTarget(job.source_kind, job.source_drive_id ?? undefined);
    const batch = this.ctx.repos.driveImports.claimItems(
      job.id,
      this.ctx.config.driveImportBatchSize,
    );
    for (const item of batch) {
      signal?.throwIfAborted();
      await this.copyItem(job, bucket, target, item, signal);
    }
    this.ctx.repos.driveImports.refreshAndMaybeFinish(job.id);
  }

  private async copyItem(
    job: DriveImportJobRow,
    bucket: AccessibleBucketRow,
    sourceTarget: DriveOperationTarget,
    item: DriveImportItemRow,
    signal?: AbortSignal,
  ): Promise<void> {
    const staging = this.ctx.repos.objectStaging.byRequestId(item.staging_request_id);
    if (staging?.status === "committed") {
      const object = this.ctx.repos.objects.findAnyByKey(bucket.id, item.object_key);
      this.ctx.repos.driveImports.markItem(item.id, "imported", null, object?.id);
      return;
    }
    if (staging?.status === "uploaded") {
      try {
        const committed = this.ctx.repos.objects.commitStagedObject(staging.id, { ifAbsent: true });
        this.ctx.repos.driveImports.markItem(item.id, "imported", null, committed.current.id);
      } catch {
        this.ctx.repos.objectStaging.markFailed(staging.id, "destination key exists");
        if (staging.new_drive_file_id) {
          this.ctx.repos.pendingCleanup.enqueue({
            userId: bucket.user_id,
            resourceType: "drive_file",
            resourceId: staging.new_drive_file_id,
            reason: "drive_import_conflict",
            driveTargetId: bucket.drive_target_id,
          });
        }
        this.ctx.repos.driveImports.markItem(item.id, "conflict", "destination_key_exists");
      }
      return;
    }
    if (staging?.status === "uploading") {
      this.ctx.repos.objectStaging.markFailed(staging.id, "interrupted_drive_import");
    }
    if (staging?.status === "uploading" || staging?.status === "failed") {
      this.ctx.repos.objectStaging.delete(staging.id);
    }

    let importedBody: ReadableStream<Uint8Array> | null = null;
    try {
      const source = await this.ctx.driveStorage.getSourceItem({
        userId: job.user_id,
        fileId: item.source_file_id,
        target: sourceTarget,
        signal,
      });
      if (!source || source.trashed) {
        this.ctx.repos.driveImports.markItem(item.id, "failed", "source_missing");
        return;
      }
      if (source.version !== item.source_version || source.modifiedTime !== item.source_modified_time) {
        this.ctx.repos.driveImports.markItem(item.id, "failed", "source_changed");
        return;
      }
      const downloadSlot = await this.ctx.driveLimits.download(job.user_id, signal);
      let response: Response;
      try {
        response = await this.ctx.driveStorage.downloadObject({
          userId: job.user_id,
          driveFileId: item.source_file_id,
          target: sourceTarget,
          signal,
        });
      } catch (error) {
        downloadSlot.release();
        throw error;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        downloadSlot.release();
        this.ctx.repos.driveImports.markItem(item.id, "failed", "source_download_failed");
        return;
      }
      const body = releaseWhenConsumed(response.body, downloadSlot);
      importedBody = body;
      const uploaded = await new ObjectService(this.ctx).upload({
        actorUserId: job.user_id,
        bucket,
        key: item.object_key,
        requestId: item.staging_request_id,
        body,
        contentLength: item.source_size_bytes,
        metadata: {
          contentType: source.mimeType || "application/octet-stream",
          userMetadata: {},
          cacheControl: null,
          contentDisposition: null,
          contentEncoding: null,
          contentLanguage: null,
          expiresAt: null,
        },
        ifAbsent: true,
        signal,
        verify: (result) => {
          if (item.source_size_bytes !== null && result.size !== item.source_size_bytes) {
            throw new Error("source size changed during import");
          }
          if (item.source_md5_checksum && result.md5Hex !== item.source_md5_checksum) {
            throw new Error("source checksum changed during import");
          }
        },
      });
      this.ctx.repos.driveImports.markItem(item.id, "imported", null, uploaded.current.id);
    } catch (error) {
      if (error instanceof ObjectAlreadyExistsError) {
        this.ctx.repos.driveImports.markItem(item.id, "conflict", "destination_key_exists");
        return;
      }
      this.ctx.repos.driveImports.markItem(
        item.id,
        "failed",
        error instanceof Error && error.message.includes("changed")
          ? "source_changed"
          : "import_failed",
      );
    } finally {
      await importedBody?.cancel().catch(() => {});
    }
  }
}

function releaseWhenConsumed(
  body: ReadableStream<Uint8Array>,
  slot: { release(): void },
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    slot.release();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          release();
          controller.close();
        } else if (next.value) {
          controller.enqueue(next.value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason);
    },
  });
}

function sourceTarget(kind: DriveImportSourceKind, driveId?: string): DriveOperationTarget {
  if (kind === "shared_drive") {
    if (!driveId) throw new DriveImportInvalidSourceError("shared drive ID is required");
    return { kind, driveId };
  }
  return { kind: "my_drive" };
}

function discovered(
  item: DriveSourceItem,
  objectKey: string,
  status: "pending" | "unsupported",
  reason?: string,
) {
  return {
    sourceFileId: item.id,
    sourceName: item.name,
    mimeType: item.mimeType,
    sizeBytes: item.size,
    md5Checksum: item.md5Checksum,
    modifiedTime: item.modifiedTime,
    version: item.version,
    objectKey,
    status,
    reason,
  };
}
