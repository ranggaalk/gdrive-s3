// Stable internal IDs and timestamps (AGENTS.md §25: UTC ISO-8601, stable IDs).

import { randomUUID } from "node:crypto";

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export const newUserId = () => id("usr");
export const newBucketId = () => id("bkt");
export const newObjectId = () => id("obj");
export const newCredentialId = () => id("akc");
export const newUploadId = () => id("mpu");
export const newCleanupId = () => id("cln");
export const newAuditId = () => id("aud");
export const newDriveTargetId = () => id("dt");
export const newPublicLinkId = () => id("lnk");
export const newDriveImportJobId = () => id("imp");
export const newDriveImportFolderId = () => id("imf");
export const newDriveImportItemId = () => id("imi");
export const newBackupAccountId = () => id("bka");
export const newBackupTransferId = () => id("bkx");
export const newTotpRecoveryCodeId = () => id("trc");

export function nowIso(): string {
  return new Date().toISOString();
}
