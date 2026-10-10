// Scheduled database snapshots, end to end: the admin API, the db:backup tool
// run as a child process against a real database file, the upload to an S3
// destination (a second in-process gateway), retention, and -- the point of
// it all -- restoring what landed there with the ordinary restore code.

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../../apps/server/src/context.ts";
import { DbSnapshotWorker } from "../../apps/server/src/jobs/db-snapshot.ts";
import { handleApi } from "../../apps/server/src/routes/api.ts";
import { handleS3 } from "../../apps/server/src/s3/router.ts";
import { DbSnapshotService } from "../../apps/server/src/services/db-snapshot-service.ts";
import { restoreEncryptedBackup } from "../../scripts/backup-core.ts";
import { makeHarness, testConfig } from "./_helpers.ts";

const ORIGIN = "http://localhost:5173";
const MINUTE = 60_000;
const PASSPHRASE = "correct horse battery staple";

const contexts: AppContext[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const ctx of contexts.splice(0)) ctx.db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Status {
  enabled: boolean;
  nextRunAt: string | null;
  lastStatus: "running" | "completed" | "failed" | null;
  lastError: string | null;
  passphraseConfigured: boolean;
  snapshots: Array<{ archiveName: string; archiveRef: string; keyRecovery: string }>;
}

interface Envelope<T> {
  data?: T;
  error?: { code: string; detail?: string };
}

async function read<T>(res: Response): Promise<Envelope<T>> {
  return (await res.json()) as Envelope<T>;
}

async function setup(options: { passphrase?: string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "drives3-db-snapshot-"));
  dirs.push(dir);
  const source = makeHarness({
    appOrigin: ORIGIN,
    sqlitePath: join(dir, "app.sqlite"),
    backupPassphrase: options.passphrase ?? null,
    backupDestinations: { ...testConfig().backupDestinations, s3AllowPrivateEndpoints: true },
  });
  const dest = makeHarness();
  contexts.push(source.ctx, dest.ctx);

  const vault = dest.seedUser("vault@x.com");
  const destCred = dest.seedCredential(vault.id);
  await dest.signAndSend({ method: "PUT", path: "/offsite", ...destCred });
  source.ctx.backupFetch = async (input, init) =>
    handleS3(dest.ctx, new Request(input, init), `req_${crypto.randomUUID()}`);

  const admin = source.ctx.repos.users.upsertOnLogin({
    googleSub: "sub-admin", email: "admin@x.com", displayName: null, hostedDomain: "x.com", isAdmin: true,
  });
  const member = source.seedUser("member@x.com");
  const apiAs = (userId: string) => {
    const session = source.ctx.sessionService.establish({ userId, userAgent: "test", ip: null });
    return (method: string, path: string, body?: unknown) =>
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
  };
  const api = apiAs(admin.id);

  const added = await read<{ id: string }>(
    await api("POST", "/api/backup-accounts", {
      kind: "s3",
      endpoint: "http://dest.test",
      bucket: "offsite",
      prefix: "gw",
      forcePathStyle: true,
      accessKeyId: destCred.accessKeyId,
      secretAccessKey: destCred.secretAccessKey,
    }),
  );
  const destination = added.data!;

  const configure = async (input: Record<string, unknown>) => {
    const res = await api("PUT", "/api/settings/db-snapshot", input);
    const body = await read<Status>(res);
    expect(res.status, JSON.stringify(body.error)).toBe(200);
    return body.data!;
  };
  const status = async () => (await read<Status>(await api("GET", "/api/settings/db-snapshot"))).data!;

  const destKeys = () =>
    dest.ctx.db
      .query<{ object_key: string }, []>("SELECT object_key FROM objects ORDER BY object_key")
      .all()
      .map((row) => row.object_key);

  /** Fetches what landed at the destination into a local file pair. */
  const download = async (archiveKey: string) => {
    const local = mkdtempSync(join(tmpdir(), "drives3-db-download-"));
    dirs.push(local);
    const name = archiveKey.split("/").pop()!;
    for (const [key, file] of [
      [archiveKey, name],
      [`${archiveKey}.manifest.json`, `${name}.manifest.json`],
    ] as const) {
      const res = await dest.signAndSend({ method: "GET", path: `/offsite/${key}`, ...destCred });
      expect(res.status).toBe(200);
      writeFileSync(join(local, file), new Uint8Array(await res.arrayBuffer()));
    }
    return { archivePath: join(local, name), dir: local };
  };

  return { source, dest, destCred, admin, member, api, apiAs, destination, configure, status, destKeys, download };
}

describe("database snapshot settings", () => {
  test("only an admin can see or change them", async () => {
    const { apiAs, member } = await setup();
    const asMember = apiAs(member.id);
    expect((await asMember("GET", "/api/settings/db-snapshot")).status).toBe(403);
    expect((await asMember("POST", "/api/settings/db-snapshot/run")).status).toBe(403);
  });

  test("need a destination of the admin's own and a sane schedule", async () => {
    const { api, source, member, destination, configure } = await setup();

    const noDestination = await api("PUT", "/api/settings/db-snapshot", { enabled: true });
    expect(noDestination.status).toBe(400);
    expect((await read<never>(noDestination)).error?.code).toBe("INVALID_DB_SNAPSHOT");

    // A destination the admin does not own -- here, another user's.
    const theirs = source.ctx.repos.backupAccounts.createDestination({
      id: "bka_someone_elses_destination_000",
      ownerUserId: member.id,
      kind: "rclone",
      label: "theirs",
      configJson: JSON.stringify({ remote: "x", path: "" }),
      encryptedSecret: null,
    });
    const foreign = await api("PUT", "/api/settings/db-snapshot", { enabled: true, backupAccountId: theirs.id });
    expect(foreign.status).toBe(400);

    const tooOften = await api("PUT", "/api/settings/db-snapshot", {
      enabled: true, backupAccountId: destination.id, frequency: "interval", intervalMinutes: 30, timezone: "UTC",
    });
    expect(tooOften.status).toBe(400);

    // There is no bucket whose writes a snapshot could wait on.
    const onChange = await api("PUT", "/api/settings/db-snapshot", {
      enabled: true, backupAccountId: destination.id, frequency: "on_change", quietMinutes: 10, maxWaitMinutes: 60,
      timezone: "UTC",
    });
    expect(onChange.status).toBe(400);
    expect((await read<never>(onChange)).error?.code).toBe("INVALID_DB_SNAPSHOT");

    const saved = await configure({
      enabled: true, backupAccountId: destination.id, frequency: "daily", timeOfDay: "03:00", timezone: "Asia/Jakarta",
    });
    expect(saved.enabled).toBe(true);
    expect(new Date(saved.nextRunAt!).getUTCHours()).toBe(20); // 03:00 WIB
    expect(saved.passphraseConfigured).toBe(false);
  });
});

describe("taking a snapshot", () => {
  test("run now ships an archive and manifest that restore with the master key", async () => {
    const { api, source, destination, configure, status, destKeys, download } = await setup();
    await configure({ enabled: true, backupAccountId: destination.id });

    expect((await api("POST", "/api/settings/db-snapshot/run")).status).toBe(202);
    let current = await status();
    for (let i = 0; i < 400 && current.lastStatus === "running"; i++) {
      await Bun.sleep(25);
      current = await status();
    }
    expect(current.lastError).toBeNull();
    expect(current.lastStatus).toBe("completed");
    expect(current.snapshots).toHaveLength(1);
    expect(current.snapshots[0]!.keyRecovery).toBe("none");

    const archiveKey = current.snapshots[0]!.archiveRef;
    expect(archiveKey).toMatch(/^gw\/_gateway-database\/drives3-.+\.sqlite\.gz\.enc$/);
    expect(destKeys()).toEqual([archiveKey, `${archiveKey}.manifest.json`, "gw/.drives3-backup.json"].sort());

    const { archivePath, dir } = await download(archiveKey);
    const target = join(dir, "restored.sqlite");
    restoreEncryptedBackup({ encryptedPath: archivePath, targetPath: target, key: source.ctx.config.masterEncryptionKey });
    const restored = new Database(target, { readonly: true });
    try {
      const emails = restored.query<{ email: string }, []>("SELECT email FROM users ORDER BY email").all();
      expect(emails.map((row) => row.email)).toEqual(["admin@x.com", "member@x.com"]);
    } finally {
      restored.close();
    }
  });

  test("with BACKUP_PASSPHRASE set, the passphrase alone restores it and gives the key back", async () => {
    const { source, destination, configure, download } = await setup({ passphrase: PASSPHRASE });
    await configure({ enabled: true, backupAccountId: destination.id });
    await new DbSnapshotService(source.ctx).startNow();

    const snapshot = source.ctx.repos.dbSnapshots.listRecent(1)[0]!;
    expect(snapshot.key_recovery).toBe("passphrase");
    const { archivePath, dir } = await download(snapshot.archive_ref);
    const result = restoreEncryptedBackup({
      encryptedPath: archivePath,
      targetPath: join(dir, "restored.sqlite"),
      passphrase: PASSPHRASE,
    });
    expect(result.recoveredKey?.equals(source.ctx.config.masterEncryptionKey)).toBe(true);
  });

  test("retention keeps the newest snapshots at the destination and deletes the rest", async () => {
    const { source, destination, configure, destKeys } = await setup();
    await configure({ enabled: true, backupAccountId: destination.id, retainCount: 2 });
    const service = new DbSnapshotService(source.ctx);
    for (let i = 0; i < 3; i++) await service.startNow();

    const kept = source.ctx.repos.dbSnapshots.listRecent(10);
    expect(kept).toHaveLength(2);
    const archives = destKeys().filter((key) => key.endsWith(".sqlite.gz.enc"));
    expect(archives.sort()).toEqual(kept.map((row) => row.archive_ref).sort());
    expect(destKeys().filter((key) => key.endsWith(".manifest.json"))).toHaveLength(2);
  });

  test("the schedule fires once when due", async () => {
    const { source, destination, configure } = await setup();
    await configure({ enabled: true, backupAccountId: destination.id, frequency: "interval", intervalMinutes: 60, timezone: "UTC" });
    const at = new Date(Date.now() + 61 * MINUTE);

    expect(await new DbSnapshotWorker(source.ctx, () => new Date(Date.now() + 30 * MINUTE)).runOnce()).toBe(false);
    expect(await new DbSnapshotWorker(source.ctx, () => at).runOnce()).toBe(true);
    expect(await new DbSnapshotWorker(source.ctx, () => at).runOnce()).toBe(false);
    expect(source.ctx.repos.dbSnapshots.listRecent(10)).toHaveLength(1);
    expect(source.ctx.repos.dbSnapshots.getSettings().next_run_at).toBe(new Date(at.getTime() + 60 * MINUTE).toISOString());
  });

  test("a destination that refuses the upload fails the snapshot and says why", async () => {
    const { source, dest, destCred, destination, configure, status } = await setup();
    await configure({ enabled: true, backupAccountId: destination.id });
    const credential = dest.ctx.repos.credentials.findActiveByAccessKeyId(destCred.accessKeyId)!;
    dest.ctx.repos.credentials.revoke(credential.user_id, credential.id);

    await new DbSnapshotService(source.ctx).startNow();
    const current = await status();
    expect(current.lastStatus).toBe("failed");
    expect(current.lastError).toContain("InvalidAccessKeyId");
    expect(source.ctx.repos.backupAccounts.findById(destination.id)!.status).toBe("error");
  });

  test("a second run while one is going is refused", async () => {
    const { api, destination, configure, status } = await setup();
    await configure({ enabled: true, backupAccountId: destination.id });
    expect((await api("POST", "/api/settings/db-snapshot/run")).status).toBe(202);
    const second = await api("POST", "/api/settings/db-snapshot/run");
    expect(second.status).toBe(409);
    for (let i = 0; i < 400 && (await status()).lastStatus === "running"; i++) await Bun.sleep(25);
  });

  test("a snapshot left running by a shutdown is marked interrupted", async () => {
    const { source } = await setup();
    source.ctx.repos.dbSnapshots.claimNow(new Date().toISOString());
    expect(source.ctx.repos.dbSnapshots.failInterrupted()).toBe(true);
    const settings = source.ctx.repos.dbSnapshots.getSettings();
    expect(settings.last_status).toBe("failed");
    expect(settings.last_error).toContain("interrupted");
  });
});
