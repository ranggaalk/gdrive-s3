// Backup schedules: one per (bucket, destination) pair, each queueing ordinary
// runs into backup_transfers when it falls due.

import type { Database } from "bun:sqlite";
import type { ScheduleFrequency, ScheduleTiming } from "../../backup/schedule-time.ts";
import type { BackupDestinationKind } from "./backup-accounts.ts";
import type { BackupTransferStatus } from "./backup-transfers.ts";
import { nowIso } from "../../util/ids.ts";

/**
 * What last happened to a schedule: what it did when it fell due, or how the
 * run it queued ended. "waiting_quiet" is an on-change schedule holding its
 * run back while the bucket is still being written to.
 */
export type BackupScheduleOutcome =
  | "queued"
  | "skipped_unchanged"
  | "skipped_active"
  | "skipped_destination"
  | "waiting_quiet"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused"
  | "error";

export interface BackupScheduleRow {
  id: string;
  owner_user_id: string;
  bucket_id: string;
  backup_account_id: string;
  enabled: number;
  frequency: ScheduleFrequency;
  interval_minutes: number | null;
  time_of_day: string | null;
  days_of_week: string | null;
  timezone: string;
  skip_if_unchanged: number;
  next_run_at: string | null;
  last_checked_at: string | null;
  last_outcome: BackupScheduleOutcome | null;
  last_transfer_id: string | null;
  consecutive_failures: number;
  paused_reason: string | null;
  created_at: string;
  updated_at: string;
  quiet_minutes: number | null;
  max_wait_minutes: number | null;
  /** On-change only: when the scheduler first saw changes not yet backed up. */
  pending_since: string | null;
}

/** A schedule joined with the names and last run the dashboard shows. */
export interface BackupScheduleListRow extends BackupScheduleRow {
  bucket_name: string;
  account_label: string;
  account_kind: BackupDestinationKind;
  last_transfer_status: BackupTransferStatus | null;
}

export class BackupScheduleExistsError extends Error {
  constructor() {
    super("This bucket already has a schedule for that destination");
    this.name = "BackupScheduleExistsError";
  }
}

export function timingOf(row: BackupScheduleRow): ScheduleTiming {
  return {
    frequency: row.frequency,
    intervalMinutes: row.interval_minutes,
    timeOfDay: row.time_of_day,
    daysOfWeek: row.days_of_week ? row.days_of_week.split(",").map(Number) : null,
    timezone: row.timezone,
    quietMinutes: row.quiet_minutes,
    maxWaitMinutes: row.max_wait_minutes,
  };
}

const LIST_SELECT = `
  SELECT s.*, b.name AS bucket_name, a.email AS account_label, a.kind AS account_kind,
         t.status AS last_transfer_status
    FROM backup_schedules s
    JOIN buckets b ON b.id = s.bucket_id
    JOIN backup_accounts a ON a.id = s.backup_account_id
    LEFT JOIN backup_transfers t ON t.id = s.last_transfer_id`;

export class BackupSchedulesRepository {
  constructor(private readonly db: Database) {}

  findById(id: string): BackupScheduleRow | null {
    return this.db.query<BackupScheduleRow, [string]>("SELECT * FROM backup_schedules WHERE id = ?").get(id) ?? null;
  }

  findOwned(ownerUserId: string, id: string): BackupScheduleRow | null {
    return (
      this.db
        .query<BackupScheduleRow, [string, string]>(
          "SELECT * FROM backup_schedules WHERE id = ? AND owner_user_id = ?",
        )
        .get(id, ownerUserId) ?? null
    );
  }

  findOwnedListRow(ownerUserId: string, id: string): BackupScheduleListRow | null {
    return (
      this.db
        .query<BackupScheduleListRow, [string, string]>(`${LIST_SELECT} WHERE s.id = ? AND s.owner_user_id = ?`)
        .get(id, ownerUserId) ?? null
    );
  }

  listForUser(ownerUserId: string, filter: { bucketId?: string } = {}): BackupScheduleListRow[] {
    const where = ["s.owner_user_id = ?"];
    const params: string[] = [ownerUserId];
    if (filter.bucketId) {
      where.push("s.bucket_id = ?");
      params.push(filter.bucketId);
    }
    return this.db
      .query<BackupScheduleListRow, string[]>(
        `${LIST_SELECT} WHERE ${where.join(" AND ")} ORDER BY b.name ASC, s.created_at ASC`,
      )
      .all(...params);
  }

  /** Enabled schedules whose time has come, most overdue first. */
  listDue(now: string, limit: number): BackupScheduleRow[] {
    return this.db
      .query<BackupScheduleRow, [string, number]>(
        `SELECT * FROM backup_schedules
          WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
          ORDER BY next_run_at ASC LIMIT ?`,
      )
      .all(now, limit);
  }

  create(input: {
    id: string;
    ownerUserId: string;
    bucketId: string;
    backupAccountId: string;
    timing: ScheduleTiming;
    skipIfUnchanged: boolean;
    enabled: boolean;
    nextRunAt: string | null;
  }): BackupScheduleRow {
    const now = nowIso();
    try {
      this.db
        .query(
          `INSERT INTO backup_schedules
             (id, owner_user_id, bucket_id, backup_account_id, enabled, frequency, interval_minutes,
              time_of_day, days_of_week, timezone, quiet_minutes, max_wait_minutes, skip_if_unchanged,
              next_run_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.ownerUserId,
          input.bucketId,
          input.backupAccountId,
          input.enabled ? 1 : 0,
          input.timing.frequency,
          input.timing.intervalMinutes,
          input.timing.timeOfDay,
          input.timing.daysOfWeek?.join(",") ?? null,
          input.timing.timezone,
          input.timing.quietMinutes,
          input.timing.maxWaitMinutes,
          input.skipIfUnchanged ? 1 : 0,
          input.nextRunAt,
          now,
          now,
        );
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) throw new BackupScheduleExistsError();
      throw error;
    }
    return this.findById(input.id)!;
  }

  /**
   * Replaces the timing and switches. Turning a schedule on clears whatever
   * paused it, and the failure count with it. It also forgets when changes
   * started waiting, as does a change of frequency: the maximum wait counts
   * from when the scheduler was watching, not from before a pause.
   */
  update(
    id: string,
    input: { timing: ScheduleTiming; skipIfUnchanged: boolean; enabled: boolean; nextRunAt: string | null },
  ): void {
    // The CASEs read the row as it was before this UPDATE.
    this.db
      .query(
        `UPDATE backup_schedules
            SET frequency = ?, interval_minutes = ?, time_of_day = ?, days_of_week = ?, timezone = ?,
                quiet_minutes = ?, max_wait_minutes = ?,
                skip_if_unchanged = ?, enabled = ?, next_run_at = ?,
                paused_reason = CASE WHEN ? = 1 THEN NULL ELSE paused_reason END,
                consecutive_failures = CASE WHEN ? = 1 AND enabled = 0 THEN 0 ELSE consecutive_failures END,
                pending_since = CASE WHEN frequency <> ? OR (? = 1 AND enabled = 0) THEN NULL ELSE pending_since END,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        input.timing.frequency,
        input.timing.intervalMinutes,
        input.timing.timeOfDay,
        input.timing.daysOfWeek?.join(",") ?? null,
        input.timing.timezone,
        input.timing.quietMinutes,
        input.timing.maxWaitMinutes,
        input.skipIfUnchanged ? 1 : 0,
        input.enabled ? 1 : 0,
        input.nextRunAt,
        input.enabled ? 1 : 0,
        input.enabled ? 1 : 0,
        input.timing.frequency,
        input.enabled ? 1 : 0,
        nowIso(),
        id,
      );
  }

  /**
   * Takes one due slot: moves next_run_at on, but only if nobody else already
   * has. Two scheduler passes racing for the same slot -- overlapping ticks,
   * or a second process on the same database -- see one winner, so a slot can
   * never queue two runs.
   */
  claimSlot(id: string, expectedNextRunAt: string, nextRunAt: string, now: string): boolean {
    return (
      this.db
        .query(
          `UPDATE backup_schedules SET next_run_at = ?, last_checked_at = ?, updated_at = ?
            WHERE id = ? AND enabled = 1 AND next_run_at = ?`,
        )
        .run(nextRunAt, now, now, id, expectedNextRunAt).changes > 0
    );
  }

  recordOutcome(
    id: string,
    input: {
      outcome: BackupScheduleOutcome;
      transferId?: string;
      consecutiveFailures?: number;
    },
  ): void {
    this.db
      .query(
        `UPDATE backup_schedules
            SET last_outcome = ?,
                last_transfer_id = COALESCE(?, last_transfer_id),
                consecutive_failures = COALESCE(?, consecutive_failures),
                updated_at = ?
          WHERE id = ?`,
      )
      .run(input.outcome, input.transferId ?? null, input.consecutiveFailures ?? null, nowIso(), id);
  }

  setPendingSince(id: string, pendingSince: string | null): void {
    this.db
      .query("UPDATE backup_schedules SET pending_since = ?, updated_at = ? WHERE id = ?")
      .run(pendingSince, nowIso(), id);
  }

  /** Switches a schedule off on its own account, saying why. */
  pause(id: string, reason: string): void {
    this.db
      .query(
        `UPDATE backup_schedules
            SET enabled = 0, paused_reason = ?, last_outcome = 'paused', updated_at = ?
          WHERE id = ?`,
      )
      .run(reason.slice(0, 500), nowIso(), id);
  }

  delete(ownerUserId: string, id: string): boolean {
    return (
      this.db.query("DELETE FROM backup_schedules WHERE id = ? AND owner_user_id = ?").run(id, ownerUserId)
        .changes > 0
    );
  }
}
