// Durable cleanup queue for Drive/temp resources (AGENTS.md §8, §9).

import type { Database } from "bun:sqlite";
import { newCleanupId, nowIso } from "../../util/ids.ts";

export type CleanupResourceType = "drive_file" | "temp_file";

export interface PendingCleanupRow {
  id: string;
  user_id: string;
  resource_type: CleanupResourceType;
  resource_id: string;
  reason: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  drive_target_id: string | null;
}

export class PendingCleanupRepository {
  constructor(private readonly db: Database) {}

  /** Idempotent for the same user/type/resource while queued. */
  enqueue(input: {
    userId: string;
    resourceType: CleanupResourceType;
    resourceId: string;
    reason: string;
    nextAttemptAt?: string;
    driveTargetId?: string | null;
  }): PendingCleanupRow {
    const existing = this.db
      .query<PendingCleanupRow, [string, string, string]>(
        `SELECT * FROM pending_cleanup
          WHERE user_id = ? AND resource_type = ? AND resource_id = ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.userId, input.resourceType, input.resourceId);
    if (existing) return existing;

    const id = newCleanupId();
    this.db
      .query(
        `INSERT INTO pending_cleanup
           (id, user_id, resource_type, resource_id, reason,
            attempts, next_attempt_at, created_at, drive_target_id)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.resourceType,
        input.resourceId,
        input.reason,
        input.nextAttemptAt ?? nowIso(),
        nowIso(),
        input.driveTargetId ?? null,
      );
    return this.byId(id)!;
  }

  byId(id: string): PendingCleanupRow | null {
    return (
      this.db
        .query<PendingCleanupRow, [string]>("SELECT * FROM pending_cleanup WHERE id = ?")
        .get(id) ?? null
    );
  }

  due(now: string, limit: number): PendingCleanupRow[] {
    return this.db
      .query<PendingCleanupRow, [string, number]>(
        `SELECT * FROM pending_cleanup
          WHERE next_attempt_at <= ?
          ORDER BY next_attempt_at ASC, created_at ASC
          LIMIT ?`,
      )
      .all(now, limit);
  }

  retry(id: string, error: string, nextAttemptAt: string): void {
    this.db
      .query(
        `UPDATE pending_cleanup
            SET attempts = attempts + 1,
                last_error = ?,
                next_attempt_at = ?
          WHERE id = ?`,
      )
      .run(error, nextAttemptAt, id);
  }

  complete(id: string): void {
    this.db.query("DELETE FROM pending_cleanup WHERE id = ?").run(id);
  }

  completeResource(
    userId: string,
    resourceType: CleanupResourceType,
    resourceId: string,
  ): number {
    return this.db
      .query(
        `DELETE FROM pending_cleanup
          WHERE user_id = ? AND resource_type = ? AND resource_id = ?`,
      )
      .run(userId, resourceType, resourceId).changes;
  }

  backlog(): number {
    return (
      this.db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pending_cleanup")
        .get()?.count ?? 0
    );
  }
}
