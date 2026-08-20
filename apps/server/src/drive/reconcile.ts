// Bounded reconciliation of SQLite object metadata against Google Drive
// (AGENTS.md §18). SQLite remains the namespace source of truth; reconciliation
// only changes object status, never silently rewrites ETag/size.

import type { AppConfig } from "../config.ts";
import type { ObjectsRepository, ObjectStatus } from "../db/repositories/objects.ts";
import type { AuditLogsRepository } from "../db/repositories/audit-logs.ts";
import type { Logger } from "../observability/logger.ts";
import type { DriveStorage } from "./storage.ts";
import type { BucketsRepository } from "../db/repositories/buckets.ts";
import type { DriveTargetsRepository } from "../db/repositories/drive-targets.ts";

export interface ReconcileResult {
  examined: number;
  active: number;
  missing: number;
  externallyModified: number;
  errors: number;
  nextAfterUpdated: string | null;
}

export class ReconcileService {
  constructor(
    private readonly config: AppConfig,
    private readonly storage: DriveStorage,
    private readonly objects: ObjectsRepository,
    private readonly buckets: BucketsRepository,
    private readonly targets: DriveTargetsRepository,
    private readonly audit: AuditLogsRepository,
    private readonly log: Logger,
  ) {}

  async runUserBatch(
    userId: string,
    requestId: string,
    afterUpdated?: string,
  ): Promise<ReconcileResult> {
    const rows = this.objects.listForReconcile(userId, {
      limit: this.config.reconcileBatchSize,
      afterUpdated,
    });
    const result: ReconcileResult = {
      examined: 0,
      active: 0,
      missing: 0,
      externallyModified: 0,
      errors: 0,
      nextAfterUpdated: null,
    };

    for (const row of rows) {
      result.examined++;
      try {
        const bucket = this.buckets.findByIdOwned(userId, row.bucket_id);
        const target = bucket ? this.targets.findById(bucket.drive_target_id) : null;
        const head = await this.storage.headObject({
          userId,
          driveFileId: row.drive_file_id,
          target:
            target?.kind === "shared_drive" && target.shared_drive_id
              ? { kind: "shared_drive", driveId: target.shared_drive_id }
              : { kind: "my_drive" },
        });
        let next: ObjectStatus;
        if (!head || head.trashed) {
          next = "missing";
          result.missing++;
        } else if (
          head.size !== row.size_bytes ||
          (head.md5Hex !== null && head.md5Hex !== row.etag)
        ) {
          next = "externally_modified";
          result.externallyModified++;
        } else {
          next = "active";
          result.active++;
        }
        if (next !== row.status) {
          this.objects.markStatus(userId, row.id, next);
          this.audit.record({
            userId,
            action: "drive.reconcile.status_change",
            objectKey: row.object_key,
            statusCode: 200,
            requestId,
            detail: { from: row.status, to: next },
          });
        }
      } catch (error) {
        result.errors++;
        this.log.warn("reconcile object failed", {
          requestId,
          userId,
          objectId: row.id,
          error: error instanceof Error ? error.message : "reconcile failed",
        });
      }
      result.nextAfterUpdated = row.updated_at;
    }
    return result;
  }
}
