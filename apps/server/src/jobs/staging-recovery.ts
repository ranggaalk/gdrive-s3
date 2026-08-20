// Startup recovery for object staging (AGENTS.md §8, §22). Runs after
// migrations and before accepting traffic. It never promotes unknown bytes:
// uploaded files not referenced by the active namespace become cleanup items.

import type { AppContext } from "../context.ts";

export interface RecoveryResult {
  examined: number;
  finalized: number;
  orphaned: number;
  failed: number;
}

export function recoverStaleStaging(ctx: AppContext): RecoveryResult {
  const cutoff = new Date(Date.now() - ctx.config.stagingStaleAfterMs).toISOString();
  const rows = ctx.repos.objectStaging.listStale(cutoff, ctx.config.cleanupBatchSize);
  const result: RecoveryResult = { examined: 0, finalized: 0, orphaned: 0, failed: 0 };

  for (const row of rows) {
    result.examined++;
    if (!row.new_drive_file_id) {
      ctx.repos.objectStaging.markFailed(row.id, "stale upload without Drive file");
      result.failed++;
      continue;
    }

    const active = ctx.repos.objects.findByKey(row.bucket_id, row.object_key);
    if (active?.drive_file_id === row.new_drive_file_id) {
      // The namespace transaction committed before the process crashed.
      ctx.repos.objectStaging.markCommitted(row.id);
      result.finalized++;
      continue;
    }

    // New uploaded bytes were never promoted; treat as orphan.
    ctx.repos.pendingCleanup.enqueue({
      userId: row.user_id,
      resourceType: "drive_file",
      resourceId: row.new_drive_file_id,
      reason: "stale_object_staging",
      driveTargetId: row.drive_target_id,
    });
    ctx.repos.objectStaging.markFailed(row.id, "stale uploaded object orphaned");
    result.orphaned++;
  }
  return result;
}
