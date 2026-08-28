import { afterEach, describe, expect, test } from "bun:test";
import type { AppContext } from "../../apps/server/src/context.ts";
import { BackupAccountService } from "../../apps/server/src/services/backup-account-service.ts";
import type { AccessibleBucketRow } from "../../apps/server/src/db/repositories/buckets.ts";
import { sealToString, aad } from "../../apps/server/src/security/encryption.ts";
import { makeHarness } from "./_helpers.ts";

/**
 * The backup folder lookups talk to Google directly rather than through
 * DriveStorage, so nothing covered them and a mismatch shipped: each ensure
 * searched `drives3Type` for a value it never wrote, so every lookup missed
 * and every transfer left another duplicate folder in the destination account.
 */
interface Folder {
  id: string;
  name: string;
  appProperties: Record<string, string>;
  parents: string[];
  trashed: boolean;
}

let ctxToClose: AppContext | null = null;
afterEach(() => {
  ctxToClose?.db.close();
  ctxToClose = null;
});

function setup() {
  const harness = makeHarness();
  const { ctx } = harness;
  ctxToClose = ctx;

  const user = ctx.repos.users.upsertOnLogin({
    googleSub: "sub-owner", email: "owner@example.com", displayName: null, hostedDomain: "x.com",
  });

  const accountId = "bac_test000000000000000000000000";
  const account = ctx.repos.backupAccounts.create({
    id: accountId,
    ownerUserId: user.id,
    email: "backup@example.com",
    encryptedRefreshToken: sealToString(
      "refresh", ctx.config.masterEncryptionKey, aad.backupRefreshToken(accountId),
    ),
    grantedScopes: ctx.config.google.driveScope,
  });

  const folders: Folder[] = [];
  let seq = 0;
  const calls: string[] = [];

  ctx.backupTokenProvider.getAccessToken = async () => "test-token";
  ctx.driveFetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    calls.push(method);

    if (method === "GET" && url.searchParams.has("q")) {
      const q = url.searchParams.get("q")!;
      const property = /key='([^']+)' and value='([^']+)'/.exec(q)!;
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      return Response.json({
        files: folders.filter(
          (f) =>
            !f.trashed &&
            f.appProperties[property[1]!] === property[2]! &&
            (parent === undefined || f.parents.includes(parent)),
        ),
      });
    }
    if (method === "POST") {
      const body = JSON.parse(String(init!.body)) as {
        name: string; appProperties?: Record<string, string>; parents?: string[];
      };
      const folder: Folder = {
        id: `fld_${++seq}`, name: body.name,
        appProperties: body.appProperties ?? {}, parents: body.parents ?? [], trashed: false,
      };
      folders.push(folder);
      return Response.json(folder);
    }
    const id = decodeURIComponent(url.pathname.split("/").pop()!);
    const found = folders.find((f) => f.id === id);
    if (method === "PATCH") {
      const body = JSON.parse(String(init!.body)) as { name?: string };
      if (found && body.name !== undefined) found.name = body.name;
      return Response.json(found ?? {});
    }
    if (!found) return new Response(JSON.stringify({ error: {} }), { status: 404 });
    return Response.json(found);
  };

  const bucket = { id: "bkt_1", name: "testing-bucket" } as AccessibleBucketRow;
  const service = new BackupAccountService(ctx);

  const reload = () => ctx.repos.backupAccounts.findById(account.id)!;
  return { ctx, service, account, reload, bucket, folders, calls };
}

describe("backup destination folders", () => {
  test("repeated backups reuse the same folders", async () => {
    const { service, reload, bucket, folders } = setup();

    const results: string[] = [];
    for (let run = 0; run < 3; run++) {
      const root = await service.ensureRootFolder(reload());
      const dest = await service.ensureBucketFolder(reload(), bucket, root);
      results.push(`${root}/${dest}`);
    }

    expect(new Set(results).size).toBe(1);
    expect(folders).toHaveLength(2);
  });

  test("the root folder says it is a backup, whose, and from when", async () => {
    const { service, reload, folders, account } = setup();
    await service.ensureRootFolder(reload());

    const root = folders[0]!;
    expect(root.name).toBe(`[DRIVE-S3-BACKUP] owner@example.com ${account.created_at.slice(0, 10)}`);
    // The destination may run this gateway itself; the two roots must not look
    // alike in its Drive listing.
    expect(root.name).not.toContain("[DRIVE-S3-GATEWAY]");
  });

  test("a folder left from the old naming is renamed, not duplicated", async () => {
    const { service, reload, folders, account } = setup();
    folders.push({
      id: "old_root", name: "[DRIVE-S3-GATEWAY]", parents: [], trashed: false,
      appProperties: { drives3Type: "backup_root", drives3BackupRootFor: account.id },
    });

    const root = await service.ensureRootFolder(reload());
    expect(root).toBe("old_root");
    expect(folders).toHaveLength(1);
    expect(folders[0]!.name).toStartWith("[DRIVE-S3-BACKUP]");
  });

  test("a cached root that was deleted is replaced, not written into", async () => {
    const { service, reload, folders } = setup();
    const first = await service.ensureRootFolder(reload());

    // Someone tidies up the duplicates this bug produced.
    folders.splice(0, folders.length);

    const second = await service.ensureRootFolder(reload());
    expect(second).not.toBe(first);
    expect(folders).toHaveLength(1);
    expect(reload().root_folder_id).toBe(second);
  });

  test("a trashed root is not reused", async () => {
    const { service, reload, folders } = setup();
    await service.ensureRootFolder(reload());
    folders[0]!.trashed = true;

    await service.ensureRootFolder(reload());
    expect(folders.filter((f) => !f.trashed)).toHaveLength(1);
  });

  test("the cached root costs one call and no rename when already correct", async () => {
    const { service, reload, calls } = setup();
    await service.ensureRootFolder(reload());
    calls.length = 0;

    await service.ensureRootFolder(reload());
    expect(calls).toEqual(["GET"]);
  });

  test("two accounts backing up one bucket get separate folders", async () => {
    const { ctx, service, reload, bucket, folders, account } = setup();
    const secondId = "bac_second00000000000000000000000";
    ctx.repos.backupAccounts.create({
      id: secondId,
      ownerUserId: account.owner_user_id,
      email: "second@example.com",
      encryptedRefreshToken: sealToString(
        "refresh", ctx.config.masterEncryptionKey, aad.backupRefreshToken(secondId),
      ),
      grantedScopes: ctx.config.google.driveScope,
    });

    const rootA = await service.ensureRootFolder(reload());
    const folderA = await service.ensureBucketFolder(reload(), bucket, rootA);

    const second = ctx.repos.backupAccounts.findById(secondId)!;
    const rootB = await service.ensureRootFolder(second);
    const folderB = await service.ensureBucketFolder(
      ctx.repos.backupAccounts.findById(secondId)!, bucket, rootB,
    );

    expect(rootB).not.toBe(rootA);
    expect(folderB).not.toBe(folderA);
    expect(folders).toHaveLength(4);
  });
});
