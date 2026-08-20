import type {
  AccessibleBucketRow,
  BucketEffectiveRole,
  BucketRow,
  BucketsRepository,
} from "../db/repositories/buckets.ts";
import type {
  BucketMemberRole,
  BucketMembersRepository,
} from "../db/repositories/bucket-members.ts";
import type { UsersRepository } from "../db/repositories/users.ts";
import type { DriveTargetsRepository } from "../db/repositories/drive-targets.ts";
import type { DriveOperationTarget, DriveStorage } from "../drive/storage.ts";

export class BucketAccessDeniedError extends Error {
  constructor() {
    super("Bucket access denied");
    this.name = "BucketAccessDeniedError";
  }
}

export class BucketNamespaceConflictError extends Error {
  constructor() {
    super("Bucket name conflicts with the member namespace");
    this.name = "BucketNamespaceConflictError";
  }
}

export class BucketMemberNotFoundError extends Error {
  constructor() {
    super("DriveS3 user not found");
    this.name = "BucketMemberNotFoundError";
  }
}

export function targetForBucket(bucket: {
  storage_kind: "my_drive" | "shared_drive";
  shared_drive_id: string | null;
}): DriveOperationTarget {
  return bucket.storage_kind === "shared_drive" && bucket.shared_drive_id
    ? { kind: "shared_drive", driveId: bucket.shared_drive_id }
    : { kind: "my_drive" };
}

function roleCanWrite(role: BucketEffectiveRole): boolean {
  return role === "owner" || role === "editor";
}

export class BucketAccessService {
  constructor(
    private readonly buckets: BucketsRepository,
    private readonly members: BucketMembersRepository,
    private readonly users: UsersRepository,
    private readonly targets: DriveTargetsRepository,
    private readonly storage: DriveStorage,
  ) {}

  list(userId: string): AccessibleBucketRow[] {
    return this.buckets.listAccessible(userId);
  }

  async verifyActorAccess(
    userId: string,
    bucket: AccessibleBucketRow,
    requireWrite: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    if (bucket.storage_kind !== "shared_drive" || !bucket.shared_drive_id) return;
    const drive = await this.storage.validateSharedDrive({
      userId,
      driveId: bucket.shared_drive_id,
      requireWrite,
      signal,
    });
    if (!drive || !drive.canDownload) {
      if (bucket.effective_role !== "owner") {
        this.members.markAccess(bucket.id, userId, "inaccessible");
      }
      throw new BucketAccessDeniedError();
    }
    if (bucket.effective_role !== "owner") {
      this.members.markAccess(bucket.id, userId, "active");
    }
  }

  findByName(
    userId: string,
    name: string,
    operation: "read" | "write" | "owner" = "read",
  ): AccessibleBucketRow | null {
    const bucket = this.buckets.findAccessibleByName(userId, name);
    if (!bucket) return null;
    this.assertOperation(bucket, operation);
    return bucket;
  }

  findById(
    userId: string,
    id: string,
    operation: "read" | "write" | "owner" = "read",
  ): AccessibleBucketRow | null {
    const bucket = this.buckets.findAccessibleById(userId, id);
    if (!bucket) return null;
    this.assertOperation(bucket, operation);
    return bucket;
  }

  private assertOperation(
    bucket: AccessibleBucketRow,
    operation: "read" | "write" | "owner",
  ): void {
    if (operation === "owner" && bucket.effective_role !== "owner") {
      throw new BucketAccessDeniedError();
    }
    if (operation === "write" && !roleCanWrite(bucket.effective_role)) {
      throw new BucketAccessDeniedError();
    }
    if (bucket.storage_status !== "active") throw new BucketAccessDeniedError();
  }

  async addMember(input: {
    ownerUserId: string;
    bucketId: string;
    email: string;
    role: BucketMemberRole;
    hostedDomain: string;
    signal?: AbortSignal;
  }) {
    const bucket = this.findById(input.ownerUserId, input.bucketId, "owner");
    if (!bucket) throw new BucketMemberNotFoundError();
    if (bucket.storage_kind !== "shared_drive" || !bucket.shared_drive_id) {
      throw new BucketAccessDeniedError();
    }
    const user = this.users.findActiveByEmail(input.email, input.hostedDomain);
    if (!user || user.id === input.ownerUserId) throw new BucketMemberNotFoundError();
    if (this.buckets.hasAccessibleName(user.id, bucket.name, bucket.id)) {
      throw new BucketNamespaceConflictError();
    }
    const drive = await this.storage.validateSharedDrive({
      userId: user.id,
      driveId: bucket.shared_drive_id,
      requireWrite: input.role === "editor",
      signal: input.signal,
    });
    if (!drive || !drive.canDownload) throw new BucketAccessDeniedError();
    return this.members.add({
      bucketId: bucket.id,
      userId: user.id,
      role: input.role,
      createdBy: input.ownerUserId,
    });
  }

  listMembers(ownerUserId: string, bucketId: string) {
    const bucket = this.findById(ownerUserId, bucketId, "owner");
    if (!bucket) throw new BucketMemberNotFoundError();
    return this.members.list(bucketId);
  }

  async updateMember(
    ownerUserId: string,
    bucketId: string,
    memberUserId: string,
    role: BucketMemberRole,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const bucket = this.findById(ownerUserId, bucketId, "owner");
    if (!bucket || bucket.storage_kind !== "shared_drive" || !bucket.shared_drive_id) {
      return false;
    }
    const member = this.members.find(bucketId, memberUserId);
    if (!member) return false;
    const drive = await this.storage.validateSharedDrive({
      userId: memberUserId,
      driveId: bucket.shared_drive_id,
      requireWrite: role === "editor",
      signal,
    });
    if (!drive || !drive.canDownload) throw new BucketAccessDeniedError();
    return this.members.setRole(bucketId, memberUserId, role);
  }

  removeMember(ownerUserId: string, bucketId: string, memberUserId: string): boolean {
    const bucket = this.findById(ownerUserId, bucketId, "owner");
    if (!bucket) return false;
    return this.members.remove(bucketId, memberUserId);
  }

  operationTarget(bucket: AccessibleBucketRow): DriveOperationTarget {
    return targetForBucket(bucket);
  }

  targetRow(bucket: BucketRow) {
    return this.targets.findById(bucket.drive_target_id);
  }
}
