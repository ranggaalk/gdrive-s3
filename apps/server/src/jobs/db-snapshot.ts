// Takes the scheduled database snapshot when it falls due. Separate from the
// bucket scheduler: a snapshot can take minutes, and bucket schedules should
// not wait on it.

import type { AppContext } from "../context.ts";
import { DbSnapshotService } from "../services/db-snapshot-service.ts";

export class DbSnapshotWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private controller: AbortController | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.timer || !this.ctx.config.backupScheduler.enabled) return;
    // Nothing can be running yet in this process, so a snapshot still marked
    // running was cut off by the last shutdown.
    if (this.ctx.repos.dbSnapshots.failInterrupted()) {
      this.ctx.log.warn("a database snapshot was interrupted by the last shutdown");
    }
    setTimeout(() => void this.runOnce(), 2_000).unref?.();
    this.timer = setInterval(() => void this.runOnce(), this.ctx.config.backupScheduler.tickSeconds * 1000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.controller?.abort(new Error("database snapshot worker stopping"));
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  async runOnce(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    this.controller = new AbortController();
    try {
      return await new DbSnapshotService(this.ctx).runIfDue(this.now(), this.controller.signal);
    } catch (error) {
      this.ctx.log.warn("database snapshot pass failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      this.controller = null;
      this.running = false;
    }
  }
}
