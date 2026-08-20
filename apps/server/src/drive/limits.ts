// Per-user resource limits for Drive operations (AGENTS.md §17).

import { KeyedSemaphore, type Slot } from "../util/semaphore.ts";

export class DriveLimits {
  private readonly uploads: KeyedSemaphore;
  private readonly downloads: KeyedSemaphore;
  private readonly apiRequests: KeyedSemaphore;

  constructor(input: { uploads: number; downloads: number; apiRequests: number }) {
    this.uploads = new KeyedSemaphore(input.uploads);
    this.downloads = new KeyedSemaphore(input.downloads);
    this.apiRequests = new KeyedSemaphore(input.apiRequests);
  }

  upload(userId: string, signal?: AbortSignal): Promise<Slot> {
    return this.uploads.acquire(userId, signal);
  }

  download(userId: string, signal?: AbortSignal): Promise<Slot> {
    return this.downloads.acquire(userId, signal);
  }

  request(userId: string, signal?: AbortSignal): Promise<Slot> {
    return this.apiRequests.acquire(userId, signal);
  }
}
