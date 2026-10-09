// Builds the sink for a saved destination row, and the probe for one that is
// about to be saved.

import type { AppContext } from "../context.ts";
import type { BackupAccountRow } from "../db/repositories/backup-accounts.ts";
import { aad, openFromString } from "../security/encryption.ts";
import {
  readRcloneConfig,
  readS3Config,
  type RcloneDestinationConfig,
  type S3DestinationConfig,
} from "./destination-config.ts";
import { DriveBackupSink } from "./drive-sink.ts";
import { RcloneBackupSink } from "./rclone-sink.ts";
import { S3BackupSink } from "./s3-sink.ts";
import { DestinationUnavailableError, type BackupSink, type DestinationProbe } from "./sink.ts";

export function createBackupSink(ctx: AppContext, account: BackupAccountRow): BackupSink {
  switch (account.kind) {
    case "drive":
      return new DriveBackupSink(ctx, account);
    case "s3":
      return s3Sink(ctx, account.id, readS3Config(account.config_json), openSecret(ctx, account));
    case "rclone":
      return rcloneSink(ctx, account.id, readRcloneConfig(account.config_json));
  }
}

/** The probe for a saved S3 or rclone destination; a Drive account proves
 *  itself by refreshing its token instead. */
export function createDestinationProbe(ctx: AppContext, account: BackupAccountRow): DestinationProbe | null {
  switch (account.kind) {
    case "drive":
      return null;
    case "s3":
      return s3Sink(ctx, account.id, readS3Config(account.config_json), openSecret(ctx, account));
    case "rclone":
      return rcloneSink(ctx, account.id, readRcloneConfig(account.config_json));
  }
}

export function s3Sink(
  ctx: AppContext,
  destinationId: string,
  config: S3DestinationConfig,
  secretAccessKey: string,
): S3BackupSink {
  return new S3BackupSink({
    destinationId,
    config,
    secretAccessKey,
    fetch: ctx.backupFetch,
    maxAttempts: ctx.config.driveRetryMaxAttempts,
    partSizeBytes: ctx.config.backupDestinations.s3PartSizeBytes,
    allowPrivateEndpoints: ctx.config.backupDestinations.s3AllowPrivateEndpoints,
    gatewayOrigin: ctx.config.appOrigin,
  });
}

export function rcloneSink(
  ctx: AppContext,
  destinationId: string,
  config: RcloneDestinationConfig,
): RcloneBackupSink {
  return new RcloneBackupSink({
    destinationId,
    config,
    settings: ctx.config.backupDestinations,
    gatewayOrigin: ctx.config.appOrigin,
  });
}

function openSecret(ctx: AppContext, account: BackupAccountRow): string {
  if (!account.encrypted_secret) throw new DestinationUnavailableError("the destination has no stored secret key");
  try {
    return openFromString(
      account.encrypted_secret,
      ctx.config.masterEncryptionKey,
      aad.backupDestinationSecret(account.id),
    );
  } catch {
    throw new DestinationUnavailableError("the stored secret key could not be decrypted");
  }
}
