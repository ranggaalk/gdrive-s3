// Bucket lifecycle (AGENTS.md §22). Creates a Drive folder under the user root
// with a bucket marker, records the row, and enforces idempotency + non-empty
// delete rules. Uses stable ids; the visible Drive folder name embeds the
// bucket name for humans but is never used as the identity.

import type { BucketRow } from "../db/repositories/buckets.ts";
import { BucketsRepository } from "../db/repositories/buckets.ts";
import type { DriveOperationTarget, DriveStorage } from "../drive/storage.ts";
import type { DriveTargetsRepository } from "../db/repositories/drive-targets.ts";
import { RootFolderService } from "../drive/root-folder.ts";
import { assertValidBucketName } from "../util/bucket-name.ts";

export class BucketAlreadyOwnedError extends Error {
  constructor() {
    super("Bucket already owned by you");
    this.name = "BucketAlreadyOwnedError";
  }
}
export class BucketNotEmptyError extends Error {
  constructor() {
    super("Bucket not empty");
    this.name = "BucketNotEmptyError";
  }
}
export class BucketNotFoundError extends Error {
  constructor() {
    super("No such bucket");
    this.name = "BucketNotFoundError";
  }
}

export class SharedDriveNotFoundError extends Error {
  constructor() {
    super("Shared Drive is unavailable or not writable");
    this.name = "SharedDriveNotFoundError";
  }
}

export type BucketStorageSelection =
  | { kind: "my_drive" }
  | { kind: "shared_drive"; driveId: string };

export class BucketService {
  constructor(
    private readonly buckets: BucketsRepository,
    private readonly storage: DriveStorage,
    private readonly rootFolder: RootFolderService,
    private readonly driveTargets: DriveTargetsRepository,
    private readonly region: string,
    private readonly deleteMode: "trash" | "permanent",
  ) {}

  async create(
    userId: string,
    name: string,
    signal?: AbortSignal,
    storage: BucketStorageSelection = { kind: "my_drive" },
  ): Promise<BucketRow> {
    assertValidBucketName(name);

    const existing = this.buckets.findByName(userId, name);
    if (existing && existing.status === "active") {
      throw new BucketAlreadyOwnedError();
    }
    if (existing) throw new BucketAlreadyOwnedError();

    let targetRow;
    let target: DriveOperationTarget;
    if (storage.kind === "shared_drive") {
      const drive = await this.storage.validateSharedDrive({
        userId,
        driveId: storage.driveId,
        requireWrite: true,
        signal,
      });
      if (!drive) throw new SharedDriveNotFoundError();
      targetRow = this.driveTargets.createSharedDrive({
        ownerUserId: userId,
        sharedDriveId: drive.id,
        displayName: drive.name,
      });
      target = { kind: "shared_drive", driveId: drive.id };
    } else {
      targetRow = this.driveTargets.ensureMyDrive(userId);
      target = { kind: "my_drive" };
    }

    let rootId = targetRow.root_folder_id;
    if (!rootId) {
      rootId = await this.rootFolder.ensure(userId, signal, target);
      this.driveTargets.setRoot(targetRow.id, rootId);
    }

    const placeholder = this.buckets.create(
      userId,
      name,
      this.region,
      "pending",
      targetRow.id,
      "creating",
    );
    let folderId: string | null = null;
    try {
      folderId = await this.storage.createBucketFolder({
        userId,
        parentFolderId: rootId,
        bucketId: placeholder.id,
        bucketName: name,
        target,
        signal,
      });
      this.buckets.setDriveFolderId(userId, placeholder.id, folderId);
      return this.buckets.findByIdOwned(userId, placeholder.id)!;
    } catch (err) {
      if (folderId) {
        // Preserve an error row with the concrete folder ID so a retry or
        // operator can reconcile it without creating duplicate Drive folders.
        this.buckets.setDriveFolderId(userId, placeholder.id, folderId);
      }
      this.buckets.setStatus(userId, placeholder.id, "error");
      throw err;
    }
  }

  async delete(userId: string, bucketId: string, signal?: AbortSignal): Promise<void> {
    const bucket = this.buckets.findByIdOwned(userId, bucketId);
    if (!bucket) throw new BucketNotFoundError();
    if (this.buckets.hasObjects(bucket.id)) throw new BucketNotEmptyError();

    this.buckets.setStatus(userId, bucket.id, "deleting");
    const targetRow = this.driveTargets.findById(bucket.drive_target_id);
    const target: DriveOperationTarget =
      targetRow?.kind === "shared_drive" && targetRow.shared_drive_id
        ? { kind: "shared_drive", driveId: targetRow.shared_drive_id }
        : { kind: "my_drive" };

    if (bucket.drive_folder_id && bucket.drive_folder_id !== "pending") {
      await this.storage.deleteFile({
        userId,
        driveFileId: bucket.drive_folder_id,
        mode: this.deleteMode,
        target,
        signal,
      });
    }

    this.buckets.delete(userId, bucket.id);
  }
}
