// Scheduled backups end to end: the API that manages schedules, the scheduler
// pass that fires them (with a clock the test controls), and the worker that
// carries out what they queue. The destination is a second in-process gateway
// reached over S3, as in backup-destinations.test.ts.

import { afterEach, describe, expect, test } from "bun:test";
import type { AppConfig } from "../../apps/server/src/config.ts";
import type { AppContext } from "../../apps/server/src/context.ts";
import { BackupSchedulerWorker } from "../../apps/server/src/jobs/backup-scheduler.ts";
import { BackupTransferWorker } from "../../apps/server/src/jobs/backup-transfer.ts";
import { handleApi } from "../../apps/server/src/routes/api.ts";
import { handleS3 } from "../../apps/server/src/s3/router.ts";
import { BackupScheduleService } from "../../apps/server/src/services/backup-schedule-service.ts";
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
  nextRunAt: string | null;
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
