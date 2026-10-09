// Copies a bucket's current objects to a backup destination: a linked Drive
// account, an S3-compatible bucket, or an rclone remote. Source reads reuse
// the same driveStorage/downloadObject path a normal S3 GetObject uses; where
// and how each copy is written is the destination's sink (see backup/sink.ts).

import type { AccessibleBucketRow } from "../db/repositories/buckets.ts";
import type { BackupAccountRow } from "../db/repositories/backup-accounts.ts";
import type { BackupTransferRow } from "../db/repositories/backup-transfers.ts";
import type { ObjectRow } from "../db/repositories/objects.ts";
import type { DriveOperationTarget } from "../drive/storage.ts";
import { createBackupSink } from "../backup/destinations.ts";
import { DestinationUnavailableError, type BackupSink } from "../backup/sink.ts";
import { releaseWhenConsumed } from "../drive/stream-utils.ts";
import { EncryptionService } from "./encryption-service.ts";
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
    // An S3 or rclone destination in "error" is let through: a run is how it
    // gets retried, and one that answers again clears its own error.
    if (account.kind === "drive" && account.status !== "active") {
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

    let reached = false;
    try {
      const sink = createBackupSink(this.ctx, account);
      let destinationRef = transfer.destination_folder_id;
      if (!destinationRef) {
        destinationRef = await sink.prepare(bucket, signal);
        this.ctx.repos.backupTransfers.setDestinationFolder(transfer.id, destinationRef);
      }

      const batch = this.ctx.repos.backupTransfers.listObjectsNeedingWork(
        bucket.id,
        account.id,
        this.ctx.config.driveImportBatchSize,
      );
      const sourceTarget = this.ctx.bucketAccess.operationTarget(bucket);
      for (const object of batch) {
        signal?.throwIfAborted();
        if (await this.copyOne(transfer, bucket, sourceTarget, account, sink, destinationRef, object, signal)) {
          reached = true;
        }
      }
    } catch (error) {
      if (error instanceof DestinationUnavailableError) {
        this.ctx.repos.backupAccounts.markError(account.id, error.status, error.message);
      }
      throw error;
    }
    if (reached && account.kind !== "drive" && account.status !== "active") {
      // The destination took a copy, so whatever was wrong with it is not any
      // more. (Drive clears itself when its token refreshes.)
      this.ctx.repos.backupAccounts.markActive(account.id);
    }
    this.ctx.repos.backupTransfers.refreshAndMaybeFinish(transfer.id);
  }

  private async copyOne(
    transfer: BackupTransferRow,
    bucket: AccessibleBucketRow,
    sourceTarget: DriveOperationTarget,
    account: BackupAccountRow,
    sink: BackupSink,
    destinationRef: string,
    object: ObjectRow,
    signal?: AbortSignal,
  ): Promise<boolean> {
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
      if (sink.wantsPlaintext) body = this.plaintext(object, body);

      const { destinationId } = await sink.put({ ref: destinationRef, bucket, object, body, signal });

      this.ctx.repos.backupTransfers.markObjectCopied({
        transferId: transfer.id,
        backupAccountId: account.id,
        objectId: object.id,
        objectKey: object.object_key,
        objectEtag: object.etag,
        destinationFileId: destinationId,
      });
      return true;
    } catch (error) {
      // Neither is this object's fault: the destination is down for every
      // object, and a stopping worker interrupted this one mid-copy.
      if (error instanceof DestinationUnavailableError || signal?.aborted) throw error;
      this.ctx.repos.backupTransfers.markObjectFailed({
        transferId: transfer.id,
        backupAccountId: account.id,
        objectId: object.id,
        objectKey: object.object_key,
        objectEtag: object.etag,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      await body?.cancel().catch(() => {});
    }
  }

  /** The object's readable bytes: SSE objects are decrypted on the way out,
   *  exactly as GetObject would serve them. */
  private plaintext(object: ObjectRow, body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const encryption = this.ctx.repos.objectEncryption.find(object.id);
    if (!encryption) return body;
    if (encryption.customer_key_md5) {
      // The customer key is never stored, so there is nothing to decrypt
      // with -- and a ciphertext copy would restore as garbage.
      throw new Error("SSE-C objects cannot be backed up: the gateway does not keep the customer's key");
    }
    return new EncryptionService(this.ctx).decryptorFor({ encryption, customerKey: null, byteOffset: 0 })(body);
  }
}
