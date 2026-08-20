import type { AppContext } from "../context.ts";
import { DriveImportService } from "../services/drive-import-service.ts";

export class DriveImportWorker {
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
    this.controller?.abort(new Error("drive import worker stopping"));
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  async runOnce(): Promise<{ processed: boolean }> {
    if (this.running || this.stopping) return { processed: false };
    this.running = true;
    this.controller = new AbortController();
    try {
      const job = this.ctx.repos.driveImports.claimNextJob();
      if (!job) return { processed: false };
      try {
        await new DriveImportService(this.ctx).process(job, this.controller.signal);
      } catch (error) {
        if (this.stopping || this.controller.signal.aborted) return { processed: true };
        const message = error instanceof Error ? error.message : "drive import failed";
        this.ctx.repos.driveImports.failJob(job.id, message.slice(0, 500));
        this.ctx.log.warn("drive import job failed", { importJobId: job.id, error: message });
      }
      return { processed: true };
    } finally {
      this.controller = null;
      this.running = false;
    }
  }
}
