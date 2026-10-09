// Fires backup schedules that have fallen due, and prunes old run history.
// It only queues runs; BackupTransferWorker carries them out. Everything it
// needs lives in SQLite, so a restart loses nothing: a schedule that fell due
// while the gateway was down fires once on the first pass after.

import type { AppContext } from "../context.ts";
import { BackupScheduleService } from "../services/backup-schedule-service.ts";

const PRUNE_EVERY_MS = 60 * 60 * 1000;

export class BackupSchedulerWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastPruneAt = 0;

  constructor(
    private readonly ctx: AppContext,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.timer || !this.ctx.config.backupScheduler.enabled) return;
    setTimeout(() => void this.runOnce(), 1_000).unref?.();
    this.timer = setInterval(() => void this.runOnce(), this.ctx.config.backupScheduler.tickSeconds * 1000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  async runOnce(): Promise<{ fired: number; pruned: number }> {
    if (this.running) return { fired: 0, pruned: 0 };
    this.running = true;
    try {
      const now = this.now();
      const service = new BackupScheduleService(this.ctx);
      const { fired } = await service.runDue(now);
      let pruned = 0;
      if (now.getTime() - this.lastPruneAt >= PRUNE_EVERY_MS) {
        this.lastPruneAt = now.getTime();
        pruned = service.pruneHistory(now);
        if (pruned > 0) this.ctx.log.info("pruned old backup runs", { pruned });
      }
      return { fired, pruned };
    } catch (error) {
      this.ctx.log.warn("backup scheduler pass failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { fired: 0, pruned: 0 };
    } finally {
      this.running = false;
    }
  }
}
