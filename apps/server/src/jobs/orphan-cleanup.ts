// Orphan/temp-file cleanup worker (AGENTS.md §8, §14). Drains the
// pending_cleanup queue in bounded batches with exponential backoff. Runs
// on an interval and can also be triggered on demand.

import { unlink, rmdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppContext } from "../context.ts";
import { DriveError } from "../drive/errors.ts";
import { nextCleanupAttempt } from "../drive/retry.ts";
import { assertUnder } from "../util/multipart-path.ts";
import { nowIso } from "../util/ids.ts";

const MAX_ATTEMPTS = 12;

export class CleanupWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopping = false;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    if (this.timer) return;
    // Run once shortly after startup to drain any leftover queue.
    setTimeout(() => void this.runOnce(), 200).unref?.();
    this.timer = setInterval(() => void this.runOnce(), this.ctx.config.cleanupIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Wait for an in-flight run to finish; bounded by cleanup batch size.
    while (this.running) await new Promise((r) => setTimeout(r, 20));
  }

  async runOnce(): Promise<{ processed: number; retried: number; completed: number }> {
    if (this.running || this.stopping) return { processed: 0, retried: 0, completed: 0 };
    this.running = true;
    let processed = 0;
    let retried = 0;
    let completed = 0;
    try {
      const batch = this.ctx.repos.pendingCleanup.due(nowIso(), this.ctx.config.cleanupBatchSize);
      for (const row of batch) {
        if (this.stopping) break;
        processed++;
        try {
          if (row.resource_type === "drive_file") {
            const target = row.drive_target_id
              ? this.ctx.repos.driveTargets.findById(row.drive_target_id)
              : null;
            await this.ctx.driveStorage.deleteFile({
              userId: row.user_id,
              driveFileId: row.resource_id,
              mode: this.ctx.config.s3DeleteMode,
              target:
                target?.kind === "shared_drive" && target.shared_drive_id
                  ? { kind: "shared_drive", driveId: target.shared_drive_id }
                  : { kind: "my_drive" },
            });
          } else if (row.resource_type === "temp_file") {
            try {
              assertUnder(this.ctx.config.multipartTempDir, row.resource_id);
            } catch {
              this.ctx.log.warn("cleanup rejected temp path", { cleanupId: row.id });
              this.ctx.repos.pendingCleanup.complete(row.id);
              completed++;
              continue;
            }
            await unlink(row.resource_id).catch(() => {});
            await rmdir(dirname(row.resource_id)).catch(() => {});
          }
          this.ctx.repos.pendingCleanup.complete(row.id);
          completed++;
        } catch (error) {
          const message = error instanceof Error ? error.message : "cleanup failed";
          if (isAlreadyGone(error)) {
            this.ctx.repos.pendingCleanup.complete(row.id);
            completed++;
            continue;
          }
          if (row.attempts + 1 >= MAX_ATTEMPTS) {
            // Preserve the row as evidence/backlog; retry at most daily instead
            // of forgetting a leaked resource.
            this.ctx.repos.pendingCleanup.retry(
              row.id,
              message,
              new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            );
            this.ctx.log.warn("cleanup exhausted retries", {
              cleanupId: row.id,
              resourceType: row.resource_type,
              error: message,
            });
            retried++;
            continue;
          }
          this.ctx.repos.pendingCleanup.retry(
            row.id,
            message,
            nextCleanupAttempt(row.attempts + 1),
          );
          retried++;
        }
      }
    } finally {
      this.running = false;
    }
    return { processed, retried, completed };
  }
}

function isAlreadyGone(error: unknown): boolean {
  if (!(error instanceof DriveError)) return false;
  return error.status === 404 || error.category === "not_found";
}
