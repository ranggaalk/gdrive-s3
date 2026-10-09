// Scheduled database snapshots: the one settings row, and the record of what
// each snapshot left at its destination.

import type { Database } from "bun:sqlite";
import type { ScheduleFrequency, ScheduleTiming } from "../../backup/schedule-time.ts";
import { nowIso } from "../../util/ids.ts";

export type DbSnapshotStatus = "running" | "completed" | "failed";

export interface DbSnapshotSettingsRow {
  id: 1;
  enabled: number;
  backup_account_id: string | null;
  frequency: ScheduleFrequency;
  interval_minutes: number | null;
  time_of_day: string | null;
  days_of_week: string | null;
  timezone: string;
  retain_count: number;
  next_run_at: string | null;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_status: DbSnapshotStatus | null;
  last_error: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

export interface DbSnapshotRow {
  id: string;
  backup_account_id: string;
  archive_name: string;
  archive_ref: string;
  manifest_ref: string;
  bytes: number;
  sha256: string;
  migration_version: number;
  key_recovery: "passphrase" | "none";
  created_at: string;
}

/** What the settings look like before an admin has saved any. */
const DEFAULT_SETTINGS: DbSnapshotSettingsRow = {
  id: 1,
  enabled: 0,
  backup_account_id: null,
  frequency: "daily",
  interval_minutes: null,
  time_of_day: "03:00",
  days_of_week: null,
  timezone: "UTC",
  retain_count: 14,
  next_run_at: null,
  last_started_at: null,
  last_finished_at: null,
  last_status: null,
  last_error: null,
  updated_by: null,
  updated_at: null,
};

export function snapshotTimingOf(row: DbSnapshotSettingsRow): ScheduleTiming {
  return {
    frequency: row.frequency,
    intervalMinutes: row.interval_minutes,
    timeOfDay: row.time_of_day,
    daysOfWeek: row.days_of_week ? row.days_of_week.split(",").map(Number) : null,
    timezone: row.timezone,
  };
}

export class DbSnapshotsRepository {
  constructor(private readonly db: Database) {}

  getSettings(): DbSnapshotSettingsRow {
    return (
      this.db.query<DbSnapshotSettingsRow, []>("SELECT * FROM db_snapshot_settings WHERE id = 1").get() ??
      DEFAULT_SETTINGS
    );
  }

  saveSettings(input: {
    enabled: boolean;
    backupAccountId: string | null;
    timing: ScheduleTiming;
    retainCount: number;
    nextRunAt: string | null;
    updatedBy: string;
  }): void {
    this.db
      .query(
        `INSERT INTO db_snapshot_settings
           (id, enabled, backup_account_id, frequency, interval_minutes, time_of_day, days_of_week,
            timezone, retain_count, next_run_at, updated_by, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           enabled = excluded.enabled,
           backup_account_id = excluded.backup_account_id,
           frequency = excluded.frequency,
           interval_minutes = excluded.interval_minutes,
           time_of_day = excluded.time_of_day,
           days_of_week = excluded.days_of_week,
           timezone = excluded.timezone,
           retain_count = excluded.retain_count,
           next_run_at = excluded.next_run_at,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.enabled ? 1 : 0,
        input.backupAccountId,
        input.timing.frequency,
        input.timing.intervalMinutes,
        input.timing.timeOfDay,
        input.timing.daysOfWeek?.join(",") ?? null,
        input.timing.timezone,
        input.retainCount,
        input.nextRunAt,
        input.updatedBy,
        nowIso(),
      );
  }

  /**
   * Takes the due slot and marks the snapshot running in one step, unless one
   * is already running or another pass took the slot first.
   */
  claimDue(now: string, nextRunAt: string): boolean {
    return (
      this.db
        .query(
          `UPDATE db_snapshot_settings
              SET next_run_at = ?, last_status = 'running', last_started_at = ?, last_error = NULL
            WHERE id = 1 AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
              AND (last_status IS NULL OR last_status <> 'running')`,
        )
        .run(nextRunAt, now, now).changes > 0
    );
  }

  /** Marks a snapshot running outside the schedule ("run now"). */
  claimNow(now: string): boolean {
    this.ensureRow();
    return (
      this.db
        .query(
          `UPDATE db_snapshot_settings
              SET last_status = 'running', last_started_at = ?, last_error = NULL
            WHERE id = 1 AND (last_status IS NULL OR last_status <> 'running')`,
        )
        .run(now).changes > 0
    );
  }

  finish(status: Exclude<DbSnapshotStatus, "running">, error: string | null): void {
    this.db
      .query("UPDATE db_snapshot_settings SET last_status = ?, last_error = ?, last_finished_at = ? WHERE id = 1")
      .run(status, error?.slice(0, 1000) ?? null, nowIso());
  }

  /** A snapshot that was running when the process stopped never finished. */
  failInterrupted(): boolean {
    return (
      this.db
        .query(
          `UPDATE db_snapshot_settings
              SET last_status = 'failed', last_error = 'interrupted: the gateway stopped while it was running',
                  last_finished_at = ?
            WHERE id = 1 AND last_status = 'running'`,
        )
        .run(nowIso()).changes > 0
    );
  }

  record(row: DbSnapshotRow): void {
    this.db
      .query(
        `INSERT INTO db_snapshots
           (id, backup_account_id, archive_name, archive_ref, manifest_ref, bytes, sha256,
            migration_version, key_recovery, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.backup_account_id,
        row.archive_name,
        row.archive_ref,
        row.manifest_ref,
        row.bytes,
        row.sha256,
        row.migration_version,
        row.key_recovery,
        row.created_at,
      );
  }

  listRecent(limit: number): DbSnapshotRow[] {
    return this.db
      .query<DbSnapshotRow, [number]>("SELECT * FROM db_snapshots ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit);
  }

  /** This destination's snapshots beyond the newest `keep`, oldest first. */
  listBeyondRetention(backupAccountId: string, keep: number): DbSnapshotRow[] {
    return this.db
      .query<DbSnapshotRow, [string, number]>(
        `SELECT * FROM db_snapshots WHERE backup_account_id = ?
          ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?`,
      )
      .all(backupAccountId, keep)
      .reverse();
  }

  delete(id: string): void {
    this.db.query("DELETE FROM db_snapshots WHERE id = ?").run(id);
  }

  private ensureRow(): void {
    this.db.query("INSERT OR IGNORE INTO db_snapshot_settings (id, time_of_day) VALUES (1, '03:00')").run();
  }
}
