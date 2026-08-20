// Multipart TTL expiry worker (AGENTS.md §14). Scans multipart_uploads for
// rows whose `expires_at` has passed while still `open`, marks them expired
// under the upload lock, and hands their temp files off to the pending_cleanup
// queue (which the CleanupWorker drains with retry/backoff).

import type { AppContext } from "../context.ts";
import { assertUnder } from "../util/multipart-path.ts";
import { withUploadLock } from "../util/upload-lock.ts";
import { nowIso } from "../util/ids.ts";

export interface ExpiryRunResult {
  scanned: number;
  expired: number;
  tempFilesEnqueued: number;
  skipped: number;
}

export class MultipartExpiryWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopping = false;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    if (this.timer) return;
    // Drain any TTL-expired uploads left over from a prior process shortly
    // after boot, then repeat on the cleanup interval.
    setTimeout(() => void this.runOnce(), 250).unref?.();
    this.timer = setInterval(() => void this.runOnce(), this.ctx.config.cleanupIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.running) await new Promise((r) => setTimeout(r, 20));
  }

  async runOnce(): Promise<ExpiryRunResult> {
    const empty: ExpiryRunResult = { scanned: 0, expired: 0, tempFilesEnqueued: 0, skipped: 0 };
    if (this.running || this.stopping) return empty;
    this.running = true;
    const result: ExpiryRunResult = { ...empty };
    try {
      const batch = this.ctx.repos.multipartUploads.listExpired(
        nowIso(),
        this.ctx.config.multipartExpiryBatchSize,
      );
      for (const row of batch) {
        if (this.stopping) break;
        result.scanned++;
        try {
          const enqueued = await this.expireOne(row.id);
          if (enqueued === null) {
            result.skipped++;
          } else {
            result.expired++;
            result.tempFilesEnqueued += enqueued;
          }
        } catch (error) {
          this.ctx.log.warn("multipart expiry error", {
            uploadId: row.id,
            error: error instanceof Error ? error.message : String(error),
          });
          result.skipped++;
        }
      }
    } finally {
      this.running = false;
    }
    return result;
  }

  private async expireOne(uploadId: string): Promise<number | null> {
    return withUploadLock(this.ctx.uploadLocks, uploadId, async () => {
      const upload = this.ctx.repos.multipartUploads.byId(uploadId);
      if (!upload || upload.status !== "open") return null;
      // Row might have been renewed in the window between listExpired() and
      // the lock; skip if the TTL was extended.
      if (Date.parse(upload.expires_at) > Date.now()) return null;

      let enqueued = 0;
      const expired = this.ctx.db.transaction(() => {
        if (!this.ctx.repos.multipartUploads.markExpired(uploadId)) return false;
        for (const part of this.ctx.repos.multipartParts.deleteAll(uploadId)) {
          // Defense-in-depth: only queue paths anchored to the configured temp
          // dir. A foreign path is removed from metadata but never unlinked.
          try {
            assertUnder(this.ctx.config.multipartTempDir, part.temp_path);
          } catch {
            this.ctx.log.warn("multipart expiry rejected temp path", {
              uploadId,
              partNumber: part.part_number,
            });
            continue;
          }
          this.ctx.repos.pendingCleanup.enqueue({
            userId: upload.user_id,
            resourceType: "temp_file",
            resourceId: part.temp_path,
            reason: "multipart_expired",
          });
          enqueued++;
        }
        this.ctx.repos.audit.record({
          userId: upload.user_id,
          action: "s3.MultipartExpired",
          objectKey: upload.object_key,
          statusCode: 200,
          requestId: `expiry:${uploadId}`,
          detail: { uploadId, tempFiles: enqueued, ageSeconds: ageSeconds(upload.initiated_at) },
        });
        return true;
      })();
      if (!expired) return null;

      this.ctx.log.info("multipart upload expired", {
        uploadId,
        userId: upload.user_id,
        bucketId: upload.bucket_id,
        tempFiles: enqueued,
      });
      return enqueued;
    });
  }
}

function ageSeconds(initiatedAt: string): number {
  const started = Date.parse(initiatedAt);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((Date.now() - started) / 1000));
}
