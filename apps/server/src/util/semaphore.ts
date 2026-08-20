// Simple abortable async semaphore + keyed multi-user variant (AGENTS.md §17).
// Slots must always be released; callers use acquire()/release() through
// try/finally or the withSemaphore helper.

export interface Slot {
  release(): void;
}

interface Waiter {
  resolve(slot: Slot): void;
  reject(reason: unknown): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class Semaphore {
  private inFlight = 0;
  private waiters: Waiter[] = [];

  constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("semaphore capacity must be a positive integer");
    }
  }

  get pending(): number {
    return this.waiters.length;
  }

  get active(): number {
    return this.inFlight;
  }

  async acquire(signal?: AbortSignal): Promise<Slot> {
    signal?.throwIfAborted();
    if (this.inFlight < this.capacity) {
      this.inFlight++;
      return this.buildSlot();
    }
    return new Promise<Slot>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(signal.reason ?? new Error("aborted"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private buildSlot(): Slot {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.releaseOne();
      },
    };
  }

  private releaseOne(): void {
    const next = this.waiters.shift();
    if (!next) {
      this.inFlight = Math.max(0, this.inFlight - 1);
      return;
    }
    if (next.signal && next.onAbort) {
      next.signal.removeEventListener("abort", next.onAbort);
    }
    next.resolve(this.buildSlot());
  }
}

export class KeyedSemaphore {
  private table = new Map<string, Semaphore>();
  constructor(public readonly capacityPerKey: number) {}

  private for(key: string): Semaphore {
    let sem = this.table.get(key);
    if (!sem) {
      sem = new Semaphore(this.capacityPerKey);
      this.table.set(key, sem);
    }
    return sem;
  }

  acquire(key: string, signal?: AbortSignal): Promise<Slot> {
    return this.for(key).acquire(signal);
  }
}

export async function withSemaphore<T>(
  sem: Semaphore | KeyedSemaphore,
  key: string | undefined,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const slot =
    sem instanceof KeyedSemaphore ? await sem.acquire(key ?? "default", signal) : await sem.acquire(signal);
  try {
    return await fn();
  } finally {
    slot.release();
  }
}
