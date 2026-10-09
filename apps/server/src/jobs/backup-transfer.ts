import type { AppContext } from "../context.ts";
import { TERMINAL_TRANSFER_STATUSES } from "../db/repositories/backup-transfers.ts";
import { BackupScheduleService } from "../services/backup-schedule-service.ts";
import { BackupTransferService } from "../services/backup-transfer-service.ts";

/**
 * How long one pass keeps taking batches before it yields. Long enough that a
 * big run is not throttled to one batch per interval -- the interval only
 * decides how soon idle work is noticed -- and short enough that the event
 * loop and stop() are never kept waiting on more than the batch in flight.
 */
const DRAIN_BUDGET_MS = 20_000;

export class BackupTransferWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopping = false;
  private controller: AbortController | null = null;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    if (this.timer) return;
    setTimeout(() => void this.runOnce(), 300).unref?.();
    this.timer = setInterval(() => void this.runOnce(), this.ctx.config.driveImportIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.controller?.abort(new Error("backup transfer worker stopping"));
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  /** Works through the queue, a batch at a time, until it is empty or the
   *  pass has used its budget. */
  async runOnce(): Promise<{ processed: boolean }> {
    if (this.running || this.stopping) return { processed: false };
    this.running = true;
    this.controller = new AbortController();
    const deadline = Date.now() + DRAIN_BUDGET_MS;
    let processed = false;
    try {
      while (!this.stopping && Date.now() < deadline) {
        const transfer = this.ctx.repos.backupTransfers.claimNextJob();
        if (!transfer) break;
        processed = true;
        try {
          await new BackupTransferService(this.ctx).process(transfer, this.controller.signal);
        } catch (error) {
          if (this.stopping || this.controller.signal.aborted) break;
          const message = error instanceof Error ? error.message : "backup transfer failed";
          this.ctx.repos.backupTransfers.failJob(transfer.id, message.slice(0, 500));
          this.ctx.log.warn("backup transfer failed", { backupTransferId: transfer.id, error: message });
        }
        this.reportToSchedule(transfer.id);
      }
      return { processed };
    } finally {
      this.controller = null;
      this.running = false;
    }
  }

  /** A run a schedule queued tells the schedule how it ended, once. Claimed
   *  runs are never terminal, so a terminal one here has only just ended. */
  private reportToSchedule(transferId: string): void {
    const transfer = this.ctx.repos.backupTransfers.findById(transferId);
    if (!transfer?.schedule_id || !TERMINAL_TRANSFER_STATUSES.includes(transfer.status)) return;
    try {
      new BackupScheduleService(this.ctx).recordRunResult(transfer);
    } catch (error) {
      this.ctx.log.warn("could not report a backup run to its schedule", {
        backupTransferId: transferId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
