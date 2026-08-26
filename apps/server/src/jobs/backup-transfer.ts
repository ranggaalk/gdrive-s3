import type { AppContext } from "../context.ts";
import { BackupTransferService } from "../services/backup-transfer-service.ts";

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

  async runOnce(): Promise<{ processed: boolean }> {
    if (this.running || this.stopping) return { processed: false };
    this.running = true;
    this.controller = new AbortController();
    try {
      const transfer = this.ctx.repos.backupTransfers.claimNextJob();
      if (!transfer) return { processed: false };
      try {
        await new BackupTransferService(this.ctx).process(transfer, this.controller.signal);
      } catch (error) {
        if (this.stopping || this.controller.signal.aborted) return { processed: true };
        const message = error instanceof Error ? error.message : "backup transfer failed";
        this.ctx.repos.backupTransfers.failJob(transfer.id, message.slice(0, 500));
        this.ctx.log.warn("backup transfer failed", { backupTransferId: transfer.id, error: message });
      }
      return { processed: true };
    } finally {
      this.controller = null;
      this.running = false;
    }
  }
}
