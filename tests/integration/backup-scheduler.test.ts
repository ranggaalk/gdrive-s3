// Scheduled backups end to end: the API that manages schedules, the scheduler
// pass that fires them (with a clock the test controls), and the worker that
// carries out what they queue. The destination is a second in-process gateway
// reached over S3, as in backup-destinations.test.ts.

import { afterEach, describe, expect, test } from "bun:test";
import type { AppConfig } from "../../apps/server/src/config.ts";
import type { AppContext } from "../../apps/server/src/context.ts";
import { findSchemaDrift, runMigrations } from "../../apps/server/src/db/migrate.ts";
import { BackupSchedulerWorker } from "../../apps/server/src/jobs/backup-scheduler.ts";
import { BackupTransferWorker } from "../../apps/server/src/jobs/backup-transfer.ts";
import { handleApi } from "../../apps/server/src/routes/api.ts";
import { handleS3 } from "../../apps/server/src/s3/router.ts";
import { BackupScheduleService } from "../../apps/server/src/services/backup-schedule-service.ts";
import { newBackupAccountId } from "../../apps/server/src/util/ids.ts";
import { makeHarness, testConfig } from "./_helpers.ts";

const ORIGIN = "http://localhost:5173";
const MINUTE = 60_000;

const contexts: AppContext[] = [];
afterEach(() => {
  for (const ctx of contexts.splice(0)) ctx.db.close();
});

interface Envelope<T> {
  data?: T;
  error?: { code: string; message: string; detail?: string };
}

interface Schedule {
  id: string;
  enabled: boolean;
  frequency: string;
  intervalMinutes: number | null;
  timezone: string;
  quietMinutes: number | null;
  maxWaitMinutes: number | null;
  skipIfUnchanged: boolean;
  nextRunAt: string | null;
  pendingSince: string | null;
  lastOutcome: string | null;
  lastTransferId: string | null;
  consecutiveFailures: number;
  pausedReason: string | null;
  accountLabel: string;
  bucketName: string;
}

async function read<T>(res: Response): Promise<Envelope<T>> {
  return (await res.json()) as Envelope<T>;
}

async function setup(scheduler: Partial<AppConfig["backupScheduler"]> = {}) {
  const source = makeHarness({
    appOrigin: ORIGIN,
    backupDestinations: { ...testConfig().backupDestinations, s3AllowPrivateEndpoints: true },
    backupScheduler: { ...testConfig().backupScheduler, ...scheduler },
  });
  const dest = makeHarness();
  contexts.push(source.ctx, dest.ctx);

  const vault = dest.seedUser("vault@x.com");
  const destCred = dest.seedCredential(vault.id);
  await dest.signAndSend({ method: "PUT", path: "/offsite", ...destCred });
  source.ctx.backupFetch = async (input, init) =>
    handleS3(dest.ctx, new Request(input, init), `req_${crypto.randomUUID()}`);

  const owner = source.seedUser("owner@x.com");
  const ownerCred = source.seedCredential(owner.id);
  await source.signAndSend({ method: "PUT", path: "/photos", ...ownerCred });
  const putObject = (key: string, body: string) =>
    source.signAndSend({ method: "PUT", path: `/photos/${key}`, body, ...ownerCred });
  const bucketId = source.ctx.repos.buckets.listByName("photos")[0]!.id;

  const session = source.ctx.sessionService.establish({ userId: owner.id, userAgent: "test", ip: null });
  const api = (method: string, path: string, body?: unknown) =>
    handleApi(
      source.ctx,
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          cookie: `drives3_sid=${session.rawId}`,
          origin: ORIGIN,
          "x-csrf-token": session.csrfSecret,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      `req_${crypto.randomUUID()}`,
    );

  const destinationRes = await api("POST", "/api/backup-accounts", {
    kind: "s3",
    endpoint: "http://dest.test",
    bucket: "offsite",
    forcePathStyle: true,
    accessKeyId: destCred.accessKeyId,
    secretAccessKey: destCred.secretAccessKey,
  });
  const destination = (await read<{ id: string }>(destinationRes)).data!;

  const createSchedule = async (input: Record<string, unknown>) => {
    const res = await api("POST", "/api/backup-schedules", { bucketId, backupAccountId: destination.id, ...input });
    const body = await read<Schedule>(res);
    expect(res.status, JSON.stringify(body.error)).toBe(201);
    return body.data!;
  };
  const getSchedule = async (id: string) => {
    const list = await read<Schedule[]>(await api("GET", "/api/backup-schedules"));
    return list.data!.find((s) => s.id === id)!;
  };

  /** One scheduler pass at a chosen moment, then the worker drains the queue. */
  const tick = async (at: Date) => {
    const result = await new BackupSchedulerWorker(source.ctx, () => at).runOnce();
    await new BackupTransferWorker(source.ctx).runOnce();
    return result;
  };
  const runs = () =>
    source.ctx.db
      .query<{ id: string; triggered_by: string; status: string; copied_count: number }, []>(
        "SELECT id, triggered_by, status, copied_count FROM backup_transfers ORDER BY created_at",
      )
      .all();

  return { source, dest, destCred, owner, bucketId, destination, putObject, api, createSchedule, getSchedule, tick, runs };
}

const later = (minutes: number) => new Date(Date.now() + minutes * MINUTE);

describe("managing schedules", () => {
  test("a new schedule is due at its next slot on its own wall clock", async () => {
    const { createSchedule } = await setup();
    const schedule = await createSchedule({ frequency: "daily", timeOfDay: "02:00", timezone: "Asia/Jakarta" });
    expect(schedule.enabled).toBe(true);
    const next = new Date(schedule.nextRunAt!);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getTime() - Date.now()).toBeLessThanOrEqual(24 * 60 * MINUTE);
    // 02:00 in Jakarta (UTC+7) is 19:00 UTC.
    expect(next.getUTCHours()).toBe(19);
    expect(next.getUTCMinutes()).toBe(0);
  });

  test("bad timing, a second schedule for the same pair, or someone else's bucket are refused", async () => {
    const { api, bucketId, destination, createSchedule, source } = await setup();
    const post = (input: Record<string, unknown>) =>
      api("POST", "/api/backup-schedules", { bucketId, backupAccountId: destination.id, ...input });

    for (const input of [
      { frequency: "interval", intervalMinutes: 5, timezone: "UTC" },
      { frequency: "weekly", timeOfDay: "02:00", daysOfWeek: [], timezone: "UTC" },
      { frequency: "daily", timeOfDay: "02:00", timezone: "Nowhere/Special" },
    ]) {
      const res = await post(input);
      expect(res.status, JSON.stringify(input)).toBe(400);
      expect((await read<never>(res)).error?.code).toBe("INVALID_BACKUP_SCHEDULE");
    }

    await createSchedule({ frequency: "interval", intervalMinutes: 60, timezone: "UTC" });
    const duplicate = await post({ frequency: "daily", timeOfDay: "03:00", timezone: "UTC" });
    expect(duplicate.status).toBe(409);

    const stranger = source.seedUser("stranger@x.com");
    const theirs = source.ctx.repos.buckets.create(stranger.id, "theirs", "us-east-1", "folder-theirs");
    const foreign = await api("POST", "/api/backup-schedules", {
      bucketId: theirs.id,
      backupAccountId: destination.id,
      frequency: "interval",
      intervalMinutes: 60,
      timezone: "UTC",
    });
    expect(foreign.status).toBe(400);
    expect((await read<never>(foreign)).error?.detail).toBe("bucket not found");
  });

  test("removing the destination removes its schedules", async () => {
    const { api, destination, createSchedule } = await setup();
    await createSchedule({ frequency: "interval", intervalMinutes: 60, timezone: "UTC" });
    await api("DELETE", `/api/backup-accounts/${destination.id}`);
    const list = await read<Schedule[]>(await api("GET", "/api/backup-schedules"));
    expect(list.data).toEqual([]);
  });
});

describe("firing schedules", () => {
  test("a due schedule queues a scheduled run, which the worker finishes in one pass", async () => {
    const { putObject, createSchedule, getSchedule, tick, runs, source } = await setup();
    for (let i = 0; i < 12; i++) await putObject(`img-${i}.jpg`, `pixels ${i}`);
    const schedule = await createSchedule({ frequency: "interval", intervalMinutes: 60, timezone: "UTC" });

    expect((await tick(later(30))).fired).toBe(0);
    expect(runs()).toEqual([]);

    expect((await tick(later(61))).fired).toBe(1);
    const [run] = runs();
    // Twelve objects is three batches of five: one worker pass drains them all.
    expect(run).toMatchObject({ triggered_by: "schedule", status: "completed", copied_count: 12 });

    const after = await getSchedule(schedule.id);
    expect(after.lastOutcome).toBe("completed");
    expect(after.lastTransferId).toBe(run!.id);
    expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(later(120).getTime());
    const audit = source.ctx.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'backup.schedule.queue'")
      .get()!;
    expect(audit.n).toBe(1);
  });

  test("a slot with nothing new is skipped without a run; a change brings runs back", async () => {
    const { putObject, createSchedule, getSchedule, tick, runs } = await setup();
    await putObject("a.txt", "a");
    const schedule = await createSchedule({ frequency: "interval", intervalMinutes: 60, timezone: "UTC" });

    await tick(later(61));
    expect(runs()).toHaveLength(1);

    await tick(later(122));
    expect(runs()).toHaveLength(1);
    expect((await getSchedule(schedule.id)).lastOutcome).toBe("skipped_unchanged");

    await putObject("b.txt", "b");
    await tick(later(183));
    expect(runs()).toHaveLength(2);
    expect(runs()[1]!.copied_count).toBe(1);
  });

  test("with skipping off, every slot runs", async () => {
    const { putObject, createSchedule, tick, runs } = await setup();
    await putObject("a.txt", "a");
    await createSchedule({ frequency: "interval", intervalMinutes: 60, timezone: "UTC", skipIfUnchanged: false });
    await tick(later(61));
    await tick(later(122));
    expect(runs()).toHaveLength(2);
  });

  test("a slot that finds the previous run still going is skipped", async () => {
    const { source, owner, bucketId, destination, putObject, createSchedule, getSchedule, runs } = await setup();
    await putObject("a.txt", "a");
    const schedule = await createSchedule({ frequency: "interval", intervalMinutes: 60, timezone: "UTC" });
    source.ctx.repos.backupTransfers.create({ userId: owner.id, bucketId, backupAccountId: destination.id });

    await new BackupSchedulerWorker(source.ctx, () => later(61)).runOnce();
    expect(runs()).toHaveLength(1);
    expect((await getSchedule(schedule.id)).lastOutcome).toBe("skipped_active");
  });

  test("slots missed while the gateway was down fire once, and the next is counted from now", async () => {
    const { source, putObject, createSchedule, getSchedule, tick, runs } = await setup();
    await putObject("a.txt", "a");
    const schedule = await createSchedule({ frequency: "interval", intervalMinutes: 60, timezone: "UTC" });
    source.ctx.db
      .query("UPDATE backup_schedules SET next_run_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 3 * 24 * 60 * MINUTE).toISOString(), schedule.id);

    const now = later(0);
    await tick(now);
    await tick(now);
    expect(runs()).toHaveLength(1);
    expect((await getSchedule(schedule.id)).nextRunAt).toBe(new Date(now.getTime() + 60 * MINUTE).toISOString());
  });

  test("two passes racing for the same slot queue one run", async () => {
    const { source, putObject, createSchedule, runs } = await setup();
    await putObject("a.txt", "a");
    await createSchedule({ frequency: "interval", intervalMinutes: 60, timezone: "UTC" });

    const at = later(61);
    const results = await Promise.all([
      new BackupScheduleService(source.ctx).runDue(at),
      new BackupScheduleService(source.ctx).runDue(at),
    ]);
    expect(results.map((r) => r.fired).sort()).toEqual([0, 1]);
    expect(runs()).toHaveLength(1);
  });

  test("repeated failures pause the schedule; switching it back on clears the pause", async () => {
    const { dest, destCred, putObject, createSchedule, getSchedule, tick, runs, api } = await setup({
      maxConsecutiveFailures: 2,
    });
    await putObject("a.txt", "a");
    const schedule = await createSchedule({ frequency: "interval", intervalMinutes: 60, timezone: "UTC" });
    const credential = dest.ctx.repos.credentials.findActiveByAccessKeyId(destCred.accessKeyId)!;
    dest.ctx.repos.credentials.revoke(credential.user_id, credential.id);

    await tick(later(61));
    let current = await getSchedule(schedule.id);
    expect(current.lastOutcome).toBe("failed");
    expect(current.consecutiveFailures).toBe(1);
    expect(current.enabled).toBe(true);

    await tick(later(122));
    current = await getSchedule(schedule.id);
    expect(current.enabled).toBe(false);
    expect(current.lastOutcome).toBe("paused");
    expect(current.pausedReason).toContain("InvalidAccessKeyId");

    await tick(later(183));
    expect(runs()).toHaveLength(2);

    const resumed = await read<Schedule>(await api("PATCH", `/api/backup-schedules/${schedule.id}`, { enabled: true }));
    expect(resumed.data).toMatchObject({ enabled: true, pausedReason: null, consecutiveFailures: 0 });
    expect(resumed.data!.nextRunAt).not.toBeNull();
  });

  test("a schedule whose bucket is no longer available pauses itself", async () => {
    const { source, bucketId, putObject, createSchedule, getSchedule, tick, runs } = await setup();
    await putObject("a.txt", "a");
    const schedule = await createSchedule({ frequency: "interval", intervalMinutes: 60, timezone: "UTC" });
    source.ctx.db.query("UPDATE buckets SET status = 'error' WHERE id = ?").run(bucketId);

    await tick(later(61));
    expect(runs()).toEqual([]);
    const current = await getSchedule(schedule.id);
    expect(current.enabled).toBe(false);
    expect(current.pausedReason).toContain("no longer available");
  });
});

describe("run now, and the history", () => {
  test("run now queues a manual run that still reports to its schedule", async () => {
    const { api, putObject, createSchedule, getSchedule, runs, source } = await setup();
    await putObject("a.txt", "a");
    const schedule = await createSchedule({ frequency: "daily", timeOfDay: "02:00", timezone: "UTC" });

    const res = await api("POST", `/api/backup-schedules/${schedule.id}/run`);
    expect(res.status).toBe(202);
    await new BackupTransferWorker(source.ctx).runOnce();

    expect(runs()).toMatchObject([{ triggered_by: "manual", status: "completed" }]);
    const current = await getSchedule(schedule.id);
    expect(current.lastOutcome).toBe("completed");
    // The countdown did not move.
    expect(current.nextRunAt).toBe(schedule.nextRunAt);
  });

  test("history says what started each run, and can be filtered by it", async () => {
    const { api, bucketId, destination, putObject, createSchedule, tick } = await setup();
    await putObject("a.txt", "a");
    await createSchedule({ frequency: "interval", intervalMinutes: 60, timezone: "UTC" });
    await tick(later(61));
    await putObject("b.txt", "b");
    await api("POST", `/api/buckets/${bucketId}/backups`, { backupAccountId: destination.id });

    const all = await read<{ items: Array<{ triggeredBy: string; scheduleId: string | null }> }>(
      await api("GET", "/api/backups"),
    );
    expect(all.data!.items.map((i) => i.triggeredBy)).toEqual(["manual", "schedule"]);
    expect(all.data!.items[1]!.scheduleId).not.toBeNull();

    const scheduled = await read<{ items: unknown[] }>(await api("GET", "/api/backups?trigger=schedule"));
    expect(scheduled.data!.items).toHaveLength(1);
    expect((await api("GET", "/api/backups?trigger=cron")).status).toBe(400);
  });
});

describe("on-change schedules", () => {
  const ON_CHANGE = { frequency: "on_change", quietMinutes: 10, maxWaitMinutes: 60 };

  // The scheduler runs on the test's clock, but objects.updated_at is stamped
  // by the real one, so writes are dated on the test's clock by hand.
  const writtenAt = (ctx: AppContext, bucketId: string, at: Date) =>
    ctx.db.query("UPDATE objects SET updated_at = ? WHERE bucket_id = ?").run(at.toISOString(), bucketId);
  const minutesAfter = (start: Date, minutes: number) => new Date(start.getTime() + minutes * MINUTE);

  test("a burst is backed up in one run, once the bucket has been quiet for the quiet period", async () => {
    const { source, bucketId, putObject, createSchedule, getSchedule, tick, runs } = await setup();
    const schedule = await createSchedule(ON_CHANGE);
    const t0 = later(0);
    for (let i = 0; i < 7; i++) await putObject(`burst-${i}.jpg`, `pixels ${i}`);
    writtenAt(source.ctx, bucketId, t0);

    await tick(minutesAfter(t0, 5));
    expect(runs()).toEqual([]);
    let current = await getSchedule(schedule.id);
    expect(current.lastOutcome).toBe("waiting_quiet");
    expect(current.pendingSince).toBe(minutesAfter(t0, 5).toISOString());

    await tick(minutesAfter(t0, 11));
    expect(runs()).toMatchObject([{ triggered_by: "schedule", status: "completed", copied_count: 7 }]);
    current = await getSchedule(schedule.id);
    expect(current.pendingSince).toBeNull();
    expect(current.lastOutcome).toBe("completed");
  });

  test("with nothing left to copy, looks queue nothing and leave the last outcome alone", async () => {
    const { source, bucketId, putObject, createSchedule, getSchedule, tick, runs } = await setup();
    await putObject("a.txt", "a");
    const t0 = later(0);
    writtenAt(source.ctx, bucketId, minutesAfter(t0, -120));
    const schedule = await createSchedule(ON_CHANGE);

    // Long quiet already, so the first look backs it up straight away.
    await tick(minutesAfter(t0, 1));
    expect(runs()).toHaveLength(1);

    for (const minute of [2, 3, 20, 45, 90]) await tick(minutesAfter(t0, minute));
    expect(runs()).toHaveLength(1);
    const current = await getSchedule(schedule.id);
    expect(current.pendingSince).toBeNull();
    expect(current.lastOutcome).toBe("completed");
  });

  test("a bucket that never goes quiet is backed up once its changes have waited the maximum", async () => {
    const { source, bucketId, putObject, createSchedule, getSchedule, tick, runs } = await setup();
    await putObject("log.txt", "line 0");
    const schedule = await createSchedule(ON_CHANGE);
    const t0 = later(0);

    // A write every five minutes: never ten quiet ones.
    for (let minute = 1; minute < 61; minute += 5) {
      writtenAt(source.ctx, bucketId, minutesAfter(t0, minute));
      await tick(minutesAfter(t0, minute));
      expect(runs(), `minute ${minute}`).toEqual([]);
    }
    expect((await getSchedule(schedule.id)).pendingSince).toBe(minutesAfter(t0, 1).toISOString());

    writtenAt(source.ctx, bucketId, minutesAfter(t0, 61));
    await tick(minutesAfter(t0, 61));
    expect(runs()).toMatchObject([{ triggered_by: "schedule", status: "completed" }]);
  });

  test("the wait is kept in the database, so a restart does not reset it", async () => {
    const { source, bucketId, putObject, createSchedule, getSchedule, runs } = await setup();
    await putObject("a.txt", "a");
    const schedule = await createSchedule(ON_CHANGE);
    const t0 = later(0);

    writtenAt(source.ctx, bucketId, minutesAfter(t0, 1));
    await new BackupScheduleService(source.ctx).runDue(minutesAfter(t0, 1));
    expect((await getSchedule(schedule.id)).pendingSince).toBe(minutesAfter(t0, 1).toISOString());

    // New service and worker instances: only the database carries over.
    writtenAt(source.ctx, bucketId, minutesAfter(t0, 55));
    await new BackupSchedulerWorker(source.ctx, () => minutesAfter(t0, 55)).runOnce();
    expect(runs()).toEqual([]);
    expect((await getSchedule(schedule.id)).pendingSince).toBe(minutesAfter(t0, 1).toISOString());

    writtenAt(source.ctx, bucketId, minutesAfter(t0, 61));
    await new BackupSchedulerWorker(source.ctx, () => minutesAfter(t0, 61)).runOnce();
    expect(runs()).toHaveLength(1);
  });

  test("a run still going holds the next one back, and the wait keeps counting", async () => {
    const { source, owner, bucketId, destination, putObject, createSchedule, getSchedule, runs } = await setup();
    await putObject("a.txt", "a");
    const t0 = later(0);
    writtenAt(source.ctx, bucketId, minutesAfter(t0, -60));
    const schedule = await createSchedule(ON_CHANGE);
    source.ctx.repos.backupTransfers.create({ userId: owner.id, bucketId, backupAccountId: destination.id });

    await new BackupSchedulerWorker(source.ctx, () => minutesAfter(t0, 1)).runOnce();
    expect(runs()).toHaveLength(1);
    let current = await getSchedule(schedule.id);
    expect(current.lastOutcome).toBe("skipped_active");
    expect(current.pendingSince).toBe(minutesAfter(t0, 1).toISOString());

    await new BackupSchedulerWorker(source.ctx, () => minutesAfter(t0, 2)).runOnce();
    current = await getSchedule(schedule.id);
    expect(current.lastOutcome).toBe("skipped_active");
    expect(current.pendingSince).toBe(minutesAfter(t0, 1).toISOString());
  });

  test("an unchanged bucket is not read every minute, but a write, or the periodic look, is noticed", async () => {
    const { source, bucketId, destination, putObject, createSchedule, getSchedule, tick, runs } = await setup();
    await putObject("a.txt", "a");
    // Looks are lined up with the 15-minute periods (minIntervalMinutes).
    const period = 15 * MINUTE;
    const base = new Date((Math.floor(Date.now() / period) + 1) * period);
    writtenAt(source.ctx, bucketId, minutesAfter(base, -120));
    const schedule = await createSchedule(ON_CHANGE);

    const transfers = source.ctx.repos.backupTransfers;
    const scan = transfers.hasObjectsNeedingWork.bind(transfers);
    let scans = 0;
    transfers.hasObjectsNeedingWork = (...args) => {
      scans++;
      return scan(...args);
    };

    await tick(minutesAfter(base, 1));
    expect(runs()).toHaveLength(1);

    // As if the copy had failed and is due a retry: work that no write marks.
    source.ctx.db
      .query("UPDATE backup_object_status SET status = 'failed', attempts = 1 WHERE backup_account_id = ?")
      .run(destination.id);
    const before = scans;
    await tick(minutesAfter(base, 2));
    await tick(minutesAfter(base, 10));
    expect(scans).toBe(before);
    expect(runs()).toHaveLength(1);

    // The next period's look finds it.
    await tick(minutesAfter(base, 16));
    expect(scans).toBe(before + 1);
    expect(runs()).toHaveLength(2);
    expect(runs()[1]).toMatchObject({ status: "completed", copied_count: 1 });

    // A write is noticed at the very next look, period or not.
    await putObject("b.txt", "b");
    writtenAt(source.ctx, bucketId, minutesAfter(base, 17));
    await tick(minutesAfter(base, 18));
    const current = await getSchedule(schedule.id);
    expect(current.lastOutcome).toBe("waiting_quiet");
    expect(current.pendingSince).toBe(minutesAfter(base, 18).toISOString());
  });

  test("changes copied some other way end the wait without a run of its own", async () => {
    const { source, api, bucketId, destination, putObject, createSchedule, getSchedule, tick, runs } = await setup();
    await putObject("a.txt", "a");
    const schedule = await createSchedule(ON_CHANGE);
    const t0 = later(0);
    writtenAt(source.ctx, bucketId, t0);
    await tick(minutesAfter(t0, 2));
    expect((await getSchedule(schedule.id)).lastOutcome).toBe("waiting_quiet");

    // "Run now" copies them, and its outcome stays on the schedule.
    await api("POST", `/api/backup-schedules/${schedule.id}/run`);
    await new BackupTransferWorker(source.ctx).runOnce();
    await tick(minutesAfter(t0, 12));
    expect(runs()).toMatchObject([{ triggered_by: "manual", status: "completed" }]);
    expect(await getSchedule(schedule.id)).toMatchObject({ pendingSince: null, lastOutcome: "completed" });

    // A backup started from the bucket reports to no schedule, so "waiting"
    // gives way to "nothing to copy".
    await putObject("b.txt", "b");
    writtenAt(source.ctx, bucketId, minutesAfter(t0, 13));
    await tick(minutesAfter(t0, 14));
    expect((await getSchedule(schedule.id)).lastOutcome).toBe("waiting_quiet");
    await api("POST", `/api/buckets/${bucketId}/backups`, { backupAccountId: destination.id });
    await new BackupTransferWorker(source.ctx).runOnce();
    await tick(minutesAfter(t0, 24));
    expect(runs()).toHaveLength(2);
    expect(await getSchedule(schedule.id)).toMatchObject({ pendingSince: null, lastOutcome: "skipped_unchanged" });
  });

  test("changing the frequency, or switching the schedule back on, forgets what was waiting", async () => {
    const { source, bucketId, putObject, createSchedule, getSchedule, api } = await setup();
    await putObject("a.txt", "a");
    const schedule = await createSchedule(ON_CHANGE);
    const t0 = later(0);
    const patch = async (body: Record<string, unknown>) =>
      (await read<Schedule>(await api("PATCH", `/api/backup-schedules/${schedule.id}`, body))).data!;
    const waitAt = async (minute: number) => {
      writtenAt(source.ctx, bucketId, minutesAfter(t0, minute));
      await new BackupSchedulerWorker(source.ctx, () => minutesAfter(t0, minute)).runOnce();
      expect((await getSchedule(schedule.id)).pendingSince).toBe(minutesAfter(t0, minute).toISOString());
    };

    await waitAt(2);
    expect((await patch({ enabled: false })).pendingSince).not.toBeNull();
    expect((await patch({ enabled: true })).pendingSince).toBeNull();

    await waitAt(4);
    const interval = await patch({ frequency: "interval", intervalMinutes: 60 });
    expect(interval).toMatchObject({ pendingSince: null, quietMinutes: null, maxWaitMinutes: null });

    // Back to on-change: the old numbers went with the switch, so the defaults apply.
    expect(await patch({ frequency: "on_change" })).toMatchObject({ quietMinutes: 10, maxWaitMinutes: 360 });
  });

  test("a Drive destination that needs reconnecting counts against it only when a run is due", async () => {
    const { source, owner, bucketId, putObject, api, getSchedule, tick } = await setup();
    await putObject("a.txt", "a");
    const t0 = later(0);
    writtenAt(source.ctx, bucketId, minutesAfter(t0, -120));
    const drive = source.ctx.repos.backupAccounts.create({
      id: newBackupAccountId(),
      ownerUserId: owner.id,
      email: "personal@gmail.com",
      encryptedRefreshToken: "irrelevant-here",
      grantedScopes: "https://www.googleapis.com/auth/drive",
    });
    // Everything had been copied there before the grant was revoked.
    source.ctx.db
      .query(
        `INSERT INTO backup_object_status
           (backup_account_id, object_id, object_key, object_etag, status, attempts, created_at, updated_at)
         SELECT ?, id, object_key, etag, 'copied', 1, updated_at, updated_at FROM objects WHERE bucket_id = ?`,
      )
      .run(drive.id, bucketId);
    source.ctx.repos.backupAccounts.markError(drive.id, "reauthorization_required", "the grant was revoked");
    const created = await api("POST", "/api/backup-schedules", { bucketId, backupAccountId: drive.id, ...ON_CHANGE });
    const schedule = (await read<Schedule>(created)).data!;

    // Minutes with nothing to copy are not failed backups.
    for (const minute of [1, 2, 3, 4, 5, 6]) await tick(minutesAfter(t0, minute));
    let current = await getSchedule(schedule.id);
    expect(current).toMatchObject({ enabled: true, consecutiveFailures: 0, pendingSince: null });

    await putObject("b.txt", "b");
    writtenAt(source.ctx, bucketId, minutesAfter(t0, 7));
    await tick(minutesAfter(t0, 8));
    expect((await getSchedule(schedule.id)).consecutiveFailures).toBe(0);

    // Quiet, so a run is due, and it cannot start.
    await tick(minutesAfter(t0, 18));
    current = await getSchedule(schedule.id);
    expect(current).toMatchObject({ lastOutcome: "skipped_destination", consecutiveFailures: 1 });
    expect(current.pendingSince).toBe(minutesAfter(t0, 8).toISOString());
  });

  test("is always saved as skipping unchanged slots, needs no time zone, and checks its numbers", async () => {
    const { api, bucketId, destination } = await setup();
    const post = (input: Record<string, unknown>) =>
      api("POST", "/api/backup-schedules", { bucketId, backupAccountId: destination.id, ...input });

    for (const input of [
      { frequency: "on_change", quietMinutes: 0 },
      { frequency: "on_change", quietMinutes: 30, maxWaitMinutes: 20 },
      { frequency: "on_change", quietMinutes: 10, maxWaitMinutes: 10081 },
    ]) {
      const res = await post(input);
      expect(res.status, JSON.stringify(input)).toBe(400);
      expect((await read<never>(res)).error?.code).toBe("INVALID_BACKUP_SCHEDULE");
    }

    const res = await post({ frequency: "on_change", quietMinutes: 15, maxWaitMinutes: 120, skipIfUnchanged: false });
    expect(res.status).toBe(201);
    const created = (await read<Schedule>(res)).data!;
    expect(created).toMatchObject({
      frequency: "on_change",
      quietMinutes: 15,
      maxWaitMinutes: 120,
      skipIfUnchanged: true,
      timezone: "UTC",
      pendingSince: null,
    });
    const patched = await read<Schedule>(
      await api("PATCH", `/api/backup-schedules/${created.id}`, { skipIfUnchanged: false }),
    );
    expect(patched.data!.skipIfUnchanged).toBe(true);
  });
});

describe("upgrading to 0019", () => {
  test("an interval schedule saved before it comes through unchanged, and still fires", async () => {
    const { source, putObject, createSchedule, tick, runs } = await setup();
    await putObject("a.txt", "a");
    const schedule = await createSchedule({ frequency: "interval", intervalMinutes: 60, timezone: "UTC" });
    await tick(later(61));
    expect(runs()).toHaveLength(1);

    // Take the database back to how 0018 left it, as an upgrade finds it.
    const db = source.ctx.db;
    db.exec(`
      DROP INDEX idx_objects_bucket_status_updated;
      ALTER TABLE backup_schedules DROP COLUMN quiet_minutes;
      ALTER TABLE backup_schedules DROP COLUMN max_wait_minutes;
      ALTER TABLE backup_schedules DROP COLUMN pending_since;
      DELETE FROM schema_migrations WHERE version = 19;
    `);
    const scheduleRow = () => db.query("SELECT * FROM backup_schedules WHERE id = ?").get(schedule.id);
    const before = scheduleRow() as Record<string, unknown>;

    expect(runMigrations(db).applied).toEqual([19]);
    expect(findSchemaDrift(db)).toEqual([]);
    expect(scheduleRow()).toEqual({ ...before, quiet_minutes: null, max_wait_minutes: null, pending_since: null });
    // Nothing that points at the schedule was touched either.
    const linked = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM backup_transfers WHERE schedule_id = ?")
      .get(schedule.id)!;
    expect(linked.n).toBe(1);

    await putObject("b.txt", "b");
    await tick(later(122));
    expect(runs()).toHaveLength(2);
    expect(runs()[1]).toMatchObject({ triggered_by: "schedule", status: "completed", copied_count: 1 });
  });
});
