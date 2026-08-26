// Copies a bucket's current objects to a linked backup Drive account.
// Source reads reuse the same driveStorage/downloadObject path a normal S3
// GetObject uses; the destination write goes through a DriveClient built
// from BackupTokenProvider, since the destination is a different Google
// identity than the one driveStorage is keyed by.

import type { AccessibleBucketRow } from "../db/repositories/buckets.ts";
import type { BackupAccountRow } from "../db/repositories/backup-accounts.ts";
import type { BackupTransferRow } from "../db/repositories/backup-transfers.ts";
import type { ObjectRow } from "../db/repositories/objects.ts";
import type { DriveOperationTarget } from "../drive/storage.ts";
import { BackupAccountService } from "./backup-account-service.ts";
import { DriveClient } from "../drive/client.ts";
import { releaseWhenConsumed } from "../drive/stream-utils.ts";
import type { AppContext } from "../context.ts";

export class BackupTransferInvalidError extends Error {}

export class BackupTransferService {
  constructor(private readonly ctx: AppContext) {}

  async create(input: {
    userId: string;
    bucketId: string;
    backupAccountId: string;
  }): Promise<BackupTransferRow> {
    let bucket: AccessibleBucketRow | null;
    try {
      bucket = this.ctx.bucketAccess.findById(input.userId, input.bucketId, "owner");
    } catch {
      bucket = null;
    }
    if (!bucket) throw new BackupTransferInvalidError("bucket not found");
    const account = this.ctx.repos.backupAccounts.findOwned(input.userId, input.backupAccountId);
    if (!account) throw new BackupTransferInvalidError("backup account not found");
    if (account.status !== "active") {
      throw new BackupTransferInvalidError("backup account needs reauthorization");
    }
    return this.ctx.repos.backupTransfers.create({
      userId: input.userId,
      bucketId: input.bucketId,
      backupAccountId: input.backupAccountId,
    });
  }

  async process(transfer: BackupTransferRow, signal?: AbortSignal): Promise<void> {
    if (transfer.status === "cancel_requested") {
      this.ctx.repos.backupTransfers.refreshAndMaybeFinish(transfer.id);
      return;
    }
    const bucket = this.ctx.bucketAccess.findById(transfer.user_id, transfer.bucket_id, "owner");
    if (!bucket) throw new Error("backup source bucket is unavailable");
    const account = this.ctx.repos.backupAccounts.findOwned(transfer.user_id, transfer.backup_account_id);
    if (!account) throw new Error("backup destination account is unavailable");

    let destinationFolderId = transfer.destination_folder_id;
    if (!destinationFolderId) {
      const accounts = new BackupAccountService(this.ctx);
      const root = await accounts.ensureRootFolder(account, signal);
      destinationFolderId = await accounts.ensureBucketFolder(account, bucket, root, signal);
      this.ctx.repos.backupTransfers.setDestinationFolder(transfer.id, destinationFolderId);
    }

    const batch = this.ctx.repos.backupTransfers.listObjectsNeedingWork(
      bucket.id,
      account.id,
      this.ctx.config.driveImportBatchSize,
    );
    const sourceTarget = this.ctx.bucketAccess.operationTarget(bucket);
    for (const object of batch) {
      signal?.throwIfAborted();
      await this.copyOne(transfer, bucket, sourceTarget, account, destinationFolderId, object, signal);
    }
    this.ctx.repos.backupTransfers.refreshAndMaybeFinish(transfer.id);
  }

  private async copyOne(
    transfer: BackupTransferRow,
    bucket: AccessibleBucketRow,
    sourceTarget: DriveOperationTarget,
    account: BackupAccountRow,
    destinationFolderId: string,
    object: ObjectRow,
    signal?: AbortSignal,
  ): Promise<void> {
    let body: ReadableStream<Uint8Array> | null = null;
    try {
      const downloadSlot = await this.ctx.driveLimits.download(transfer.user_id, signal);
      let response: Response;
      try {
        response = await this.ctx.driveStorage.downloadObject({
          userId: transfer.user_id,
          driveFileId: object.drive_file_id,
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
        throw new Error(`source download failed: ${response.status}`);
      }
      body = releaseWhenConsumed(response.body, downloadSlot);

      const uploadSlot = await this.ctx.driveLimits.upload(account.id, signal);
      let uploadedId: string;
      try {
        const token = await this.ctx.backupTokenProvider.getAccessToken(account.id, signal);
        const client = new DriveClient(token, this.ctx.config.driveRetryMaxAttempts);
        const uploaded = await client.uploadMedia(
          {
            name: object.object_key,
            mimeType: object.content_type,
            appProperties: {
              drives3Type: "backup_object",
              drives3BucketId: bucket.id,
              drives3ObjectId: object.id,
            },
            parentId: destinationFolderId,
            body,
          },
          signal,
        );
        uploadedId = uploaded.id;
      } finally {
        uploadSlot.release();
      }

      this.ctx.repos.backupTransfers.markObjectCopied({
        transferId: transfer.id,
        backupAccountId: account.id,
        objectId: object.id,
        objectKey: object.object_key,
        objectEtag: object.etag,
        destinationFileId: uploadedId,
      });
    } catch (error) {
      this.ctx.repos.backupTransfers.markObjectFailed({
        transferId: transfer.id,
        backupAccountId: account.id,
        objectId: object.id,
        objectKey: object.object_key,
        objectEtag: object.etag,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await body?.cancel().catch(() => {});
    }
  }
}
