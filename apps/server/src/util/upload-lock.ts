// Non-reentrant keyed mutex for multipart Complete/Abort ordering
// (AGENTS.md §14). If a lock is contested, the second caller waits FIFO.

export interface UploadLock {
  release(): void;
}

interface QueueItem {
  resolve(lock: UploadLock): void;
  reject(reason: unknown): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class UploadLockRegistry {
  private held = new Set<string>();
  private waiters = new Map<string, QueueItem[]>();

  async acquire(key: string, signal?: AbortSignal): Promise<UploadLock> {
    signal?.throwIfAborted();
    if (!this.held.has(key)) {
      this.held.add(key);
      return this.buildLock(key);
    }
    return new Promise<UploadLock>((resolve, reject) => {
      const item: QueueItem = { resolve, reject, signal };
      if (signal) {
        item.onAbort = () => {
          const list = this.waiters.get(key) ?? [];
          const idx = list.indexOf(item);
          if (idx !== -1) list.splice(idx, 1);
          reject(signal.reason ?? new Error("aborted"));
        };
        signal.addEventListener("abort", item.onAbort, { once: true });
      }
      const list = this.waiters.get(key) ?? [];
      list.push(item);
      this.waiters.set(key, list);
    });
  }

  private buildLock(key: string): UploadLock {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.pass(key);
      },
    };
  }

  private pass(key: string): void {
    const list = this.waiters.get(key);
    const next = list?.shift();
    if (!next) {
      this.held.delete(key);
      if (list && list.length === 0) this.waiters.delete(key);
      return;
    }
    if (next.signal && next.onAbort) {
      next.signal.removeEventListener("abort", next.onAbort);
    }
    next.resolve(this.buildLock(key));
  }

  isHeld(key: string): boolean {
    return this.held.has(key);
  }
}

export async function withUploadLock<T>(
  registry: UploadLockRegistry,
  key: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const lock = await registry.acquire(key, signal);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
