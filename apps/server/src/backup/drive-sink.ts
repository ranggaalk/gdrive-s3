// Backs a bucket up to a linked secondary Google Drive account: one folder per
// bucket under the account's backup root, one file per object.

import type { AppContext } from "../context.ts";
import type { BackupAccountRow } from "../db/repositories/backup-accounts.ts";
import type { AccessibleBucketRow } from "../db/repositories/buckets.ts";
import { BackupTokenRevokedError } from "../drive/backup-token-provider.ts";
import { DriveClient } from "../drive/client.ts";
import { meteredFetch } from "../drive/metered-fetch.ts";
import { BackupAccountService } from "../services/backup-account-service.ts";
import { DestinationUnavailableError, type BackupPutInput, type BackupSink } from "./sink.ts";

export class DriveBackupSink implements BackupSink {
  /** Drive copies have always been the bytes as stored, SSE ciphertext
   *  included; this keeps them that way. */
  readonly wantsPlaintext = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly account: BackupAccountRow,
  ) {}

  async prepare(bucket: AccessibleBucketRow, signal?: AbortSignal): Promise<string> {
    return this.guarded(async () => {
      const accounts = new BackupAccountService(this.ctx);
      const root = await accounts.ensureRootFolder(this.account, signal);
      return accounts.ensureBucketFolder(this.account, bucket, root, signal);
    });
  }

  async put(input: BackupPutInput): Promise<{ destinationId: string }> {
    const { account } = this;
    const uploadSlot = await this.ctx.driveLimits.upload(account.id, input.signal);
    try {
      return await this.guarded(async () => {
        const token = await this.ctx.backupTokenProvider.getAccessToken(account.id, input.signal);
        const client = new DriveClient(
          token,
          this.ctx.config.driveRetryMaxAttempts,
          meteredFetch(this.ctx.driveQuotaMeter, account.owner_user_id, this.ctx.driveFetch),
        );
        const uploaded = await client.uploadMedia(
          {
            name: input.object.object_key,
            mimeType: input.object.content_type,
            appProperties: {
              drives3Type: "backup_object",
              drives3BucketId: input.bucket.id,
              drives3ObjectId: input.object.id,
            },
            parentId: input.ref,
            body: input.body,
          },
          input.signal,
        );
        return { destinationId: uploaded.id };
      });
    } finally {
      uploadSlot.release();
    }
  }

  /** A revoked grant fails every object alike; the token provider has
   *  already marked the account for reauthorization. */
  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BackupTokenRevokedError) {
        throw new DestinationUnavailableError(error.message, "reauthorization_required");
      }
      throw error;
    }
  }
}
