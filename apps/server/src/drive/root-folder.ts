// Ensure the per-user "DriveS3 Gateway" root folder exists (AGENTS.md §7).
// Delegates to DriveStorage so tests can use the in-memory adapter.

import type { DriveOperationTarget, DriveStorage } from "./storage.ts";

export class RootFolderService {
  constructor(private readonly storage: DriveStorage) {}

  /** Idempotently ensure the folder exists; returns its Drive folder id. */
  ensure(
    userId: string,
    signal?: AbortSignal,
    target?: DriveOperationTarget,
  ): Promise<string> {
    return this.storage.ensureUserRoot({ userId, target, signal });
  }
}
