// Scheduled backups: managing schedules, firing the ones that fall due, and
// hearing back how the runs they queued went.
//
// A schedule never copies anything itself. When it falls due it queues an
// ordinary run into backup_transfers -- unless nothing has changed since the
// last copy, in which case it skips the slot without leaving an empty run in
// the history -- and the worker that runs manual backups runs it. An
// on-change schedule falls due every minute and queues its run only once the
// bucket has gone quiet (see fireOnChange).

import type { AppContext } from "../context.ts";
import type { BackupAccountRow } from "../db/repositories/backup-accounts.ts";
import type { BackupTransferRow } from "../db/repositories/backup-transfers.ts";
import { BackupAlreadyActiveError } from "../db/repositories/backup-transfers.ts";
import {
  timingOf,
  type BackupScheduleOutcome,
  type BackupScheduleRow,
} from "../db/repositories/backup-schedules.ts";
import {
  DEFAULT_MAX_WAIT_MINUTES,
  DEFAULT_QUIET_MINUTES,
  nextRunAt,
  normalizeTiming,
  ScheduleInputError,
  type ScheduleFrequency,
  type ScheduleTiming,
} from "../backup/schedule-time.ts";
import { newRequestId } from "../observability/logger.ts";
import { newBackupScheduleId } from "../util/ids.ts";
import { BackupTransferInvalidError, BackupTransferService } from "./backup-transfer-service.ts";

export class BackupScheduleNotFoundError extends Error {}

/** How many due schedules one pass fires; the rest wait for the next tick. */
const DUE_BATCH = 50;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function asRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ScheduleInputError("expected a JSON object");
  return raw as Record<string, unknown>;
}

function optionalBool(raw: Record<string, unknown>, key: string): boolean | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ScheduleInputError(`${key} must be true or false`);
  return value;
}

/** The timing fields of a request, laid over what the schedule has now. */
function timingFrom(raw: Record<string, unknown>, current: ScheduleTiming | null): ScheduleTiming {
  const pick = <T>(key: string, fallback: T | null): T | null =>
    raw[key] === undefined ? fallback : (raw[key] as T | null);
  const frequency = pick<ScheduleFrequency>("frequency", current?.frequency ?? null);
  let timezone = pick<string>("timezone", current?.timezone ?? null);
  const daysOfWeek = pick<number[]>("daysOfWeek", current?.daysOfWeek ?? null);
  if (daysOfWeek !== null && !Array.isArray(daysOfWeek)) {
    throw new ScheduleInputError("daysOfWeek must be a list of ISO weekdays");
  }
  // An on-change schedule never reads a clock, so it need not name a zone.
  if (timezone === null && frequency === "on_change") timezone = "UTC";
  if (typeof timezone !== "string") throw new ScheduleInputError("timezone is required");
  return {
    frequency: frequency as ScheduleFrequency,
    intervalMinutes: pick<number>("intervalMinutes", current?.intervalMinutes ?? null),
    timeOfDay: pick<string>("timeOfDay", current?.timeOfDay ?? null),
    daysOfWeek,
    timezone,
    quietMinutes: pick<number>("quietMinutes", current?.quietMinutes ?? null),
    maxWaitMinutes: pick<number>("maxWaitMinutes", current?.maxWaitMinutes ?? null),
  };
}

function sameTiming(a: ScheduleTiming, b: ScheduleTiming): boolean {
  return (
    a.frequency === b.frequency &&
    a.intervalMinutes === b.intervalMinutes &&
    a.timeOfDay === b.timeOfDay &&
    (a.daysOfWeek ?? []).join(",") === (b.daysOfWeek ?? []).join(",") &&
    a.timezone === b.timezone &&
    a.quietMinutes === b.quietMinutes &&
    a.maxWaitMinutes === b.maxWaitMinutes
  );
}

/** An on-change schedule only ever runs for changes, whatever the request
 *  said about skipping slots that find none. */
function alwaysSkips(timing: ScheduleTiming): boolean {
  return timing.frequency === "on_change";
}

export class BackupScheduleService {
  constructor(private readonly ctx: AppContext) {}

  private get settings() {
    return this.ctx.config.backupScheduler;
  }

  create(ownerUserId: string, input: unknown, now = new Date()): BackupScheduleRow {
    const raw = asRecord(input);
    const bucketId = raw.bucketId;
    const backupAccountId = raw.backupAccountId;
    if (typeof bucketId !== "string" || !bucketId) throw new ScheduleInputError("bucketId is required");
    if (typeof backupAccountId !== "string" || !backupAccountId) {
      throw new ScheduleInputError("backupAccountId is required");
    }
    if (!this.ownsBucket(ownerUserId, bucketId)) throw new ScheduleInputError("bucket not found");
    if (!this.ctx.repos.backupAccounts.findOwned(ownerUserId, backupAccountId)) {
      throw new ScheduleInputError("backup destination not found");
    }
    const timing = normalizeTiming(timingFrom(raw, null), this.settings.minIntervalMinutes, { allowOnChange: true });
    const enabled = optionalBool(raw, "enabled") ?? true;
    const skipIfUnchanged = optionalBool(raw, "skipIfUnchanged") ?? true;
    return this.ctx.repos.backupSchedules.create({
      id: newBackupScheduleId(),
      ownerUserId,
      bucketId,
      backupAccountId,
      timing,
      skipIfUnchanged: alwaysSkips(timing) || skipIfUnchanged,
      enabled,
      nextRunAt: enabled ? nextRunAt(timing, now).toISOString() : null,
    });
  }

  update(ownerUserId: string, id: string, input: unknown, now = new Date()): BackupScheduleRow {
    const schedule = this.ctx.repos.backupSchedules.findOwned(ownerUserId, id);
    if (!schedule) throw new BackupScheduleNotFoundError();
    const raw = asRecord(input);
    if (raw.bucketId !== undefined || raw.backupAccountId !== undefined) {
      throw new ScheduleInputError("a schedule's bucket and destination cannot change; add another schedule");
    }
    const current = timingOf(schedule);
    const timing = normalizeTiming(timingFrom(raw, current), this.settings.minIntervalMinutes, { allowOnChange: true });
    const enabled = optionalBool(raw, "enabled") ?? schedule.enabled === 1;
    const skipIfUnchanged = optionalBool(raw, "skipIfUnchanged") ?? schedule.skip_if_unchanged === 1;

    // Keep the countdown unless the timing changed or the schedule is only
    // now being switched on; re-saving a schedule must not push it back.
    let next: string | null = null;
    if (enabled) {
      const keep = schedule.enabled === 1 && schedule.next_run_at && sameTiming(current, timing);
      next = keep ? schedule.next_run_at : nextRunAt(timing, now).toISOString();
    }
    this.ctx.repos.backupSchedules.update(id, {
      timing,
      skipIfUnchanged: alwaysSkips(timing) || skipIfUnchanged,
      enabled,
      nextRunAt: next,
    });
    return this.ctx.repos.backupSchedules.findById(id)!;
  }

  delete(ownerUserId: string, id: string): void {
    if (!this.ctx.repos.backupSchedules.delete(ownerUserId, id)) throw new BackupScheduleNotFoundError();
  }

  /** Queues a run now, outside the schedule's own timing. It reports back to
   *  the schedule like any other, but leaves the countdown alone. */
  async runNow(ownerUserId: string, id: string): Promise<BackupTransferRow> {
    const schedule = this.ctx.repos.backupSchedules.findOwned(ownerUserId, id);
    if (!schedule) throw new BackupScheduleNotFoundError();
    const transfer = await new BackupTransferService(this.ctx).create({
      userId: ownerUserId,
      bucketId: schedule.bucket_id,
      backupAccountId: schedule.backup_account_id,
      triggeredBy: "manual",
      scheduleId: schedule.id,
    });
    this.ctx.repos.backupSchedules.recordOutcome(id, { outcome: "queued", transferId: transfer.id });
    return transfer;
  }

  /** One scheduler pass: fires every schedule whose time has come. */
  async runDue(now = new Date()): Promise<{ fired: number }> {
    const nowText = now.toISOString();
    let fired = 0;
    for (const schedule of this.ctx.repos.backupSchedules.listDue(nowText, DUE_BATCH)) {
      let next: string;
      try {
        // Counted from now, not from the slot that was due: a gateway that
        // was down overnight runs once when it is back, not once per slot it
        // slept through.
        next = nextRunAt(timingOf(schedule), now).toISOString();
      } catch (error) {
        this.pause(schedule, `the schedule's timing is no longer valid: ${message(error)}`);
        continue;
      }
      if (!this.ctx.repos.backupSchedules.claimSlot(schedule.id, schedule.next_run_at!, next, nowText)) continue;
      fired++;
      try {
        await this.fire(schedule, now);
      } catch (error) {
        this.ctx.repos.backupSchedules.recordOutcome(schedule.id, { outcome: "error" });
        this.ctx.log.warn("backup schedule failed to fire", { backupScheduleId: schedule.id, error: message(error) });
      }
    }
    return { fired };
  }

  private async fire(schedule: BackupScheduleRow, now: Date): Promise<void> {
    const owner = schedule.owner_user_id;
    if (!this.ownsBucket(owner, schedule.bucket_id)) {
      this.pause(schedule, "the bucket is no longer available to its owner (removed, failing, or no longer theirs)");
      return;
    }
    const account = this.ctx.repos.backupAccounts.findOwned(owner, schedule.backup_account_id);
    if (!account) {
      this.pause(schedule, "the backup destination is gone");
      return;
    }
    if (schedule.frequency === "on_change") {
      await this.fireOnChange(schedule, account, now);
      return;
    }
    if (this.driveNeedsReconnecting(schedule, account)) return;
    if (
      schedule.skip_if_unchanged === 1 &&
      !this.ctx.repos.backupTransfers.hasObjectsNeedingWork(schedule.bucket_id, schedule.backup_account_id)
    ) {
      this.ctx.repos.backupSchedules.recordOutcome(schedule.id, { outcome: "skipped_unchanged" });
      return;
    }
    await this.queueRun(schedule);
  }

  /**
   * An on-change schedule falls due every minute, and queues a run once the
   * changes it is holding have stopped coming -- no new write for
   * quiet_minutes -- or have waited max_wait_minutes. A bulk upload is then
   * copied whole by one run, instead of a slice of it at every slot.
   *
   * pending_since is when the scheduler first noticed changes not yet backed
   * up, not when they were written: off by at most a minute, but stored, so
   * the maximum wait is a column read and holds across restarts.
   */
  private async fireOnChange(schedule: BackupScheduleRow, account: BackupAccountRow, now: Date): Promise<void> {
    const schedules = this.ctx.repos.backupSchedules;
    const transfers = this.ctx.repos.backupTransfers;
    const lastWrite = transfers.lastObjectWriteAt(schedule.bucket_id);
    let pendingSince = schedule.pending_since;
    let checked = false;

    if (pendingSince === null) {
      // hasObjectsNeedingWork reads every object in the bucket, too much to
      // do every minute for a big bucket that sits unchanged; ask only when
      // the answer can have changed. last_outcome is left alone when nothing
      // is pending, so it keeps saying how the last run went.
      if (lastWrite === null || !this.mayHaveNewWork(schedule, lastWrite, now)) return;
      if (!transfers.hasObjectsNeedingWork(schedule.bucket_id, schedule.backup_account_id)) return;
      pendingSince = now.toISOString();
      schedules.setPendingSince(schedule.id, pendingSince);
      checked = true;
    }

    const quietMs = (schedule.quiet_minutes ?? DEFAULT_QUIET_MINUTES) * MINUTE_MS;
    const maxWaitMs = (schedule.max_wait_minutes ?? DEFAULT_MAX_WAIT_MINUTES) * MINUTE_MS;
    const quiet = lastWrite === null || Date.parse(lastWrite) <= now.getTime() - quietMs;
    const overdue = Date.parse(pendingSince) <= now.getTime() - maxWaitMs;
    if (!quiet && !overdue) {
      schedules.recordOutcome(schedule.id, { outcome: "waiting_quiet" });
      return;
    }
    if (!checked && !transfers.hasObjectsNeedingWork(schedule.bucket_id, schedule.backup_account_id)) {
      // What was waiting went some other way: copied by a run started by
      // hand, or deleted. Only an outcome that says the schedule is holding
      // back gives way; how a "run now" went says more than "skipped".
      schedules.setPendingSince(schedule.id, null);
      if (schedule.last_outcome === "waiting_quiet" || schedule.last_outcome === "skipped_active") {
        schedules.recordOutcome(schedule.id, { outcome: "skipped_unchanged" });
      }
      return;
    }
    // Checked only now, not every minute: what counts as a failure is a run
    // that was due and could not start, not a minute with nothing to copy.
    if (this.driveNeedsReconnecting(schedule, account)) return;
    // A run that could not start keeps pending_since: its changes are still
    // waiting, and the maximum wait still counts from when they started.
    if (await this.queueRun(schedule)) schedules.setPendingSince(schedule.id, null);
  }

  /**
   * Whether an on-change schedule can find work its previous look did not:
   * something was written since then. Once every minIntervalMinutes it looks
   * regardless -- as often as an interval schedule may -- since two things
   * leave work behind without a write: a copy that failed and is due a retry,
   * and a write stamped by a clock that has since stepped back.
   */
  private mayHaveNewWork(schedule: BackupScheduleRow, lastWrite: string, now: Date): boolean {
    // The row was read before this pass claimed its slot, so last_checked_at
    // is still the previous look's `now`.
    const previous = schedule.last_checked_at;
    if (previous === null || Date.parse(lastWrite) > Date.parse(previous)) return true;
    const period = this.settings.minIntervalMinutes * MINUTE_MS;
    return Math.floor(now.getTime() / period) !== Math.floor(Date.parse(previous) / period);
  }

  /**
   * A Drive destination that lost its grant cannot run until it is linked
   * again. Each slot like this counts as a failure, so the schedule pauses
   * instead of silently skipping forever.
   */
  private driveNeedsReconnecting(schedule: BackupScheduleRow, account: BackupAccountRow): boolean {
    if (account.kind !== "drive" || account.status === "active") return false;
    this.countFailure(schedule, "skipped_destination", "the Drive destination needs reconnecting");
    return true;
  }

  /** Queues the schedule's run; false when it could not, having said why. */
  private async queueRun(schedule: BackupScheduleRow): Promise<boolean> {
    try {
      const transfer = await new BackupTransferService(this.ctx).create({
        userId: schedule.owner_user_id,
        bucketId: schedule.bucket_id,
        backupAccountId: schedule.backup_account_id,
        triggeredBy: "schedule",
        scheduleId: schedule.id,
      });
      this.ctx.repos.backupSchedules.recordOutcome(schedule.id, { outcome: "queued", transferId: transfer.id });
      this.ctx.repos.audit.record({
        userId: schedule.owner_user_id,
        action: "backup.schedule.queue",
        bucketId: schedule.bucket_id,
        requestId: newRequestId(),
        statusCode: 202,
        detail: { backupScheduleId: schedule.id, backupTransferId: transfer.id },
      });
      return true;
    } catch (error) {
      if (error instanceof BackupAlreadyActiveError) {
        // Most likely the previous slot's run, still going; this slot's
        // changes will be in it or in the next one.
        this.ctx.repos.backupSchedules.recordOutcome(schedule.id, { outcome: "skipped_active" });
        return false;
      }
      if (error instanceof BackupTransferInvalidError) {
        this.countFailure(schedule, "skipped_destination", error.message);
        return false;
      }
      throw error;
    }
  }

  /**
   * Called by the worker when a run that a schedule queued (or a schedule's
   * "run now") ends. A completed run resets the failure count -- even one
   * where some objects failed, since the destination was clearly working --
   * and a failed run adds to it, pausing the schedule at the limit.
   */
  recordRunResult(transfer: BackupTransferRow): void {
    if (!transfer.schedule_id) return;
    const schedule = this.ctx.repos.backupSchedules.findById(transfer.schedule_id);
    if (!schedule) return;
    if (transfer.status === "completed") {
      this.ctx.repos.backupSchedules.recordOutcome(schedule.id, { outcome: "completed", consecutiveFailures: 0 });
    } else if (transfer.status === "cancelled") {
      this.ctx.repos.backupSchedules.recordOutcome(schedule.id, { outcome: "cancelled" });
    } else if (transfer.status === "failed") {
      this.countFailure(schedule, "failed", transfer.last_error ?? "the run failed");
    }
  }

  /** Prunes finished runs past the retention window; returns how many. */
  pruneHistory(now = new Date()): number {
    const days = this.settings.historyRetentionDays;
    if (days <= 0) return 0;
    return this.ctx.repos.backupTransfers.pruneHistory(new Date(now.getTime() - days * DAY_MS).toISOString());
  }

  private countFailure(schedule: BackupScheduleRow, outcome: BackupScheduleOutcome, reason: string): void {
    const failures = schedule.consecutive_failures + 1;
    this.ctx.repos.backupSchedules.recordOutcome(schedule.id, { outcome, consecutiveFailures: failures });
    if (failures >= this.settings.maxConsecutiveFailures && schedule.enabled === 1) {
      this.pause(schedule, `${failures} scheduled backups in a row did not succeed; the last said: ${reason}`);
    }
  }

  private pause(schedule: BackupScheduleRow, reason: string): void {
    this.ctx.repos.backupSchedules.pause(schedule.id, reason);
    this.ctx.repos.audit.record({
      userId: schedule.owner_user_id,
      action: "backup.schedule.pause",
      bucketId: schedule.bucket_id,
      requestId: newRequestId(),
      statusCode: 200,
      detail: { backupScheduleId: schedule.id, reason },
    });
    this.ctx.log.warn("backup schedule paused", { backupScheduleId: schedule.id, reason });
  }

  private ownsBucket(userId: string, bucketId: string): boolean {
    try {
      return Boolean(this.ctx.bucketAccess.findById(userId, bucketId, "owner"));
    } catch {
      return false;
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

