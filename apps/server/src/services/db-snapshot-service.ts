// Scheduled snapshots of the gateway's own database, sent to one of the
// admin's backup destinations.
//
// A bucket backup copies objects; this copies what makes sense of them: the
// bucket/key -> Drive file mapping, the S3 credentials, the KMS keys. It is the
// archive `db:backup` writes -- encrypted under MASTER_ENCRYPTION_KEY, and with
// BACKUP_PASSPHRASE set, carrying that key wrapped under the passphrase -- so a
// server lost along with its disk can be rebuilt from the destination alone.

import { mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AppContext } from "../context.ts";
import type { BackupAccountRow } from "../db/repositories/backup-accounts.ts";
import { snapshotTimingOf, type DbSnapshotSettingsRow } from "../db/repositories/db-snapshots.ts";
import { writeDbArchive } from "../backup/db-archive.ts";
import { createBackupSink } from "../backup/destinations.ts";
import { nextRunAt, normalizeTiming, ScheduleInputError, type ScheduleTiming } from "../backup/schedule-time.ts";
import { DestinationUnavailableError, type BackupSink } from "../backup/sink.ts";
import { newRequestId } from "../observability/logger.ts";
import { newDbSnapshotId } from "../util/ids.ts";

/** A snapshot is a full copy of the database; more often than hourly buys
 *  little and costs a lot. */
export const MIN_SNAPSHOT_INTERVAL_MINUTES = 60;
const MAX_RETAIN = 365;
const RECENT_LIMIT = 10;

export class DbSnapshotBusyError extends Error {
  constructor() {
    super("a database snapshot is already running");
    this.name = "DbSnapshotBusyError";
  }
}

export class DbSnapshotService {
  constructor(private readonly ctx: AppContext) {}

  status() {
    const settings = this.ctx.repos.dbSnapshots.getSettings();
    const account = settings.backup_account_id
      ? this.ctx.repos.backupAccounts.findById(settings.backup_account_id)
      : null;
    const labels = new Map<string, string>();
    const labelOf = (id: string) => {
      if (!labels.has(id)) labels.set(id, this.ctx.repos.backupAccounts.findById(id)?.email ?? id);
      return labels.get(id)!;
    };
    return {
      enabled: settings.enabled === 1,
      backupAccountId: settings.backup_account_id,
      destination: account ? { id: account.id, label: account.email, kind: account.kind, status: account.status } : null,
      frequency: settings.frequency,
      intervalMinutes: settings.interval_minutes,
      timeOfDay: settings.time_of_day,
      daysOfWeek: settings.days_of_week ? settings.days_of_week.split(",").map(Number) : null,
      timezone: settings.timezone,
      retainCount: settings.retain_count,
      nextRunAt: settings.enabled === 1 ? settings.next_run_at : null,
      lastStartedAt: settings.last_started_at,
      lastFinishedAt: settings.last_finished_at,
      lastStatus: settings.last_status,
      lastError: settings.last_error,
      passphraseConfigured: this.ctx.config.backupPassphrase !== null,
      schedulerEnabled: this.ctx.config.backupScheduler.enabled,
      minIntervalMinutes: MIN_SNAPSHOT_INTERVAL_MINUTES,
      snapshots: this.ctx.repos.dbSnapshots.listRecent(RECENT_LIMIT).map((row) => ({
        id: row.id,
        archiveName: row.archive_name,
        archiveRef: row.archive_ref,
        destinationLabel: labelOf(row.backup_account_id),
        bytes: row.bytes,
        migrationVersion: row.migration_version,
        keyRecovery: row.key_recovery,
        createdAt: row.created_at,
      })),
    };
  }

  /** Saves the schedule. The destination must be the saving admin's own:
   *  the archive holds every user's secrets, and goes where they point it. */
  save(adminUserId: string, input: unknown, now = new Date()): void {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ScheduleInputError("expected a JSON object");
    }
    const raw = input as Record<string, unknown>;
    const current = this.ctx.repos.dbSnapshots.getSettings();
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
      throw new ScheduleInputError("enabled must be true or false");
    }
    const enabled = (raw.enabled as boolean | undefined) ?? current.enabled === 1;

    let backupAccountId = current.backup_account_id;
    if (raw.backupAccountId !== undefined) {
      if (raw.backupAccountId !== null && typeof raw.backupAccountId !== "string") {
        throw new ScheduleInputError("backupAccountId must be a destination id");
      }
      backupAccountId = (raw.backupAccountId as string | null) || null;
    }
    if (backupAccountId && backupAccountId !== current.backup_account_id) {
      if (!this.ctx.repos.backupAccounts.findOwned(adminUserId, backupAccountId)) {
        throw new ScheduleInputError("backup destination not found among your own destinations");
      }
    }
    if (enabled && !backupAccountId) throw new ScheduleInputError("choose a destination before turning snapshots on");

    const merged: ScheduleTiming = {
      ...snapshotTimingOf(current),
      ...pickTiming(raw),
    };
    const timing = normalizeTiming(merged, MIN_SNAPSHOT_INTERVAL_MINUTES);

    let retainCount = current.retain_count;
    if (raw.retainCount !== undefined) {
      if (typeof raw.retainCount !== "number" || !Number.isInteger(raw.retainCount) || raw.retainCount < 1 || raw.retainCount > MAX_RETAIN) {
        throw new ScheduleInputError(`retainCount must be a whole number from 1 to ${MAX_RETAIN}`);
      }
      retainCount = raw.retainCount;
    }

    this.ctx.repos.dbSnapshots.saveSettings({
      enabled,
      backupAccountId,
      timing,
      retainCount,
      nextRunAt: enabled ? nextRunAt(timing, now).toISOString() : null,
      updatedBy: adminUserId,
    });
  }

  /** Takes a snapshot if one is due; resolves once it has finished. */
  async runIfDue(now = new Date(), signal?: AbortSignal): Promise<boolean> {
    const settings = this.ctx.repos.dbSnapshots.getSettings();
    if (settings.enabled !== 1 || !settings.next_run_at || settings.next_run_at > now.toISOString()) return false;
    // As with bucket schedules, a missed slot runs once and the next is
    // counted from now.
    const next = nextRunAt(snapshotTimingOf(settings), now).toISOString();
    if (!this.ctx.repos.dbSnapshots.claimDue(now.toISOString(), next)) return false;
    await this.execute(signal);
    return true;
  }

  /** Starts a snapshot outside the schedule. The returned promise settles when
   *  it has finished; the caller need not wait for it. */
  startNow(): Promise<void> {
    if (!this.ctx.repos.dbSnapshots.claimNow(new Date().toISOString())) throw new DbSnapshotBusyError();
    return this.execute();
  }

  /** Runs a snapshot already marked running. Never throws: the outcome is
   *  recorded on the settings row for the dashboard to show. */
  private async execute(signal?: AbortSignal): Promise<void> {
    let account: BackupAccountRow | null = null;
    try {
      const settings = this.ctx.repos.dbSnapshots.getSettings();
      account = settings.backup_account_id
        ? this.ctx.repos.backupAccounts.findById(settings.backup_account_id)
        : null;
      if (!account) throw new Error("no backup destination is chosen for database snapshots");
      await this.snapshotTo(account, settings, signal);
      this.ctx.repos.dbSnapshots.finish("completed", null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof DestinationUnavailableError && account) {
        this.ctx.repos.backupAccounts.markError(account.id, error.status, message);
      }
      this.ctx.repos.dbSnapshots.finish("failed", message);
      this.ctx.log.warn("database snapshot failed", { error: message });
    }
  }

  private async snapshotTo(account: BackupAccountRow, settings: DbSnapshotSettingsRow, signal?: AbortSignal) {
    const { sqlitePath } = this.ctx.config;
    if (sqlitePath === ":memory:") throw new Error("the database is in memory; there is no file to snapshot");
    // Next to the database, not in /tmp: same filesystem, same permissions,
    // and inside the volume an operator already sized for it.
    const workDir = mkdtempSync(join(dirname(sqlitePath), ".db-snapshot-"));
    try {
      const archive = await writeDbArchive({
        sqlitePath,
        outDir: workDir,
        masterKey: this.ctx.config.masterEncryptionKey,
        passphrase: this.ctx.config.backupPassphrase,
        signal,
      });
      const sink = createBackupSink(this.ctx, account);
      const ref = await sink.prepareGatewayArea(signal);
      const upload = async (path: string, contentType: string) => {
        const file = Bun.file(path);
        return (await sink.putFile({ ref, name: basename(path), body: file.stream(), size: file.size, contentType, signal }))
          .destinationId;
      };
      // Archive first: a manifest without its archive is worse than the other
      // way round, which db:restore handles.
      const archiveRef = await upload(archive.encryptedPath, "application/octet-stream");
      const manifestRef = await upload(archive.manifestPath, "application/json");
      this.ctx.repos.dbSnapshots.record({
        id: newDbSnapshotId(),
        backup_account_id: account.id,
        archive_name: archive.manifest.encryptedFile,
        archive_ref: archiveRef,
        manifest_ref: manifestRef,
        bytes: archive.manifest.bytes,
        sha256: archive.manifest.sha256,
        migration_version: archive.manifest.migrationVersion,
        key_recovery: archive.manifest.keyRecovery,
        created_at: archive.manifest.createdAt,
      });
      this.ctx.repos.audit.record({
        userId: settings.updated_by ?? account.owner_user_id,
        action: "db.snapshot.create",
        requestId: newRequestId(),
        statusCode: 201,
        // Not bytesOut: that feeds the traffic charts, which are about S3.
        detail: { backupAccountId: account.id, archive: archive.manifest.encryptedFile, bytes: archive.manifest.bytes },
      });
      await this.prune(sink, account.id, settings.retain_count, signal);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  /**
   * Deletes this destination's snapshots beyond the newest `keep` -- only
   * ones this gateway recorded writing, never anything else there. A failure
   * leaves the rest for the next snapshot to try; the new one is safe either
   * way.
   */
  private async prune(sink: BackupSink, backupAccountId: string, keep: number, signal?: AbortSignal) {
    for (const old of this.ctx.repos.dbSnapshots.listBeyondRetention(backupAccountId, keep)) {
      try {
        await sink.deleteFile(old.manifest_ref, signal);
        await sink.deleteFile(old.archive_ref, signal);
        this.ctx.repos.dbSnapshots.delete(old.id);
      } catch (error) {
        this.ctx.log.warn("could not delete an old database snapshot", {
          archive: old.archive_name,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
  }
}

function pickTiming(raw: Record<string, unknown>): Partial<ScheduleTiming> {
  const out: Partial<ScheduleTiming> = {};
  if (raw.frequency !== undefined) out.frequency = raw.frequency as ScheduleTiming["frequency"];
  if (raw.intervalMinutes !== undefined) out.intervalMinutes = raw.intervalMinutes as number | null;
  if (raw.timeOfDay !== undefined) out.timeOfDay = raw.timeOfDay as string | null;
  if (raw.daysOfWeek !== undefined) {
    if (raw.daysOfWeek !== null && !Array.isArray(raw.daysOfWeek)) {
      throw new ScheduleInputError("daysOfWeek must be a list of ISO weekdays");
    }
    out.daysOfWeek = raw.daysOfWeek as number[] | null;
  }
  if (raw.timezone !== undefined) {
    if (typeof raw.timezone !== "string") throw new ScheduleInputError("timezone must be a time zone name");
    out.timezone = raw.timezone;
  }
  return out;
}
