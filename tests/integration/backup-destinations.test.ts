// S3 and rclone backup destinations, end to end: the dashboard API that adds
// them, and the transfer worker that fills them.
//
// The S3 destination is a second gateway running in-process, reached through
// the injectable backupFetch -- so these tests also prove the outbound SigV4
// signer against the same verifier every S3 client is held to. The rclone
// destination is a stand-in script that stores what `rclone rcat` is given
// under a temporary directory, which covers everything up to the rclone
// binary itself.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../../apps/server/src/context.ts";
import { BackupTransferWorker } from "../../apps/server/src/jobs/backup-transfer.ts";
import { handleApi } from "../../apps/server/src/routes/api.ts";
import { handleS3 } from "../../apps/server/src/s3/router.ts";
import { makeHarness, testConfig } from "./_helpers.ts";

const ORIGIN = "http://localhost:5173";
const DEST_ENDPOINT = "http://dest.test";
const MIB = 1024 * 1024;

const contexts: AppContext[] = [];
const tempDirs: string[] = [];
afterEach(() => {
  for (const ctx of contexts.splice(0)) ctx.db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.RCLONE_FAKE_ROOT;
});

interface Envelope<T> {
  data?: T;
  error?: { code: string; message: string; detail?: string };
}

interface Destination {
  id: string;
  kind: string;
  label: string;
  status: string;
  lastError: string | null;
  config: Record<string, unknown> | null;
}

async function read<T>(res: Response): Promise<Envelope<T>> {
  return (await res.json()) as Envelope<T>;
}

async function setup(options: { partSizeBytes?: number; rcloneRemotes?: string[]; rcloneBinary?: string } = {}) {
  const source = makeHarness({
    appOrigin: ORIGIN,
    backupDestinations: {
      ...testConfig().backupDestinations,
      // The destination below is "dest.test"; nothing resolves it.
      s3AllowPrivateEndpoints: true,
      s3PartSizeBytes: options.partSizeBytes ?? 16 * MIB,
      rcloneRemotes: options.rcloneRemotes ?? [],
      rcloneBinary: options.rcloneBinary ?? "rclone",
    },
  });
  const dest = makeHarness();
  contexts.push(source.ctx, dest.ctx);

  const vault = dest.seedUser("vault@x.com");
  const destCred = dest.seedCredential(vault.id);
  expect((await dest.signAndSend({ method: "PUT", path: "/offsite", ...destCred })).status).toBe(200);

  const destRequests: Array<{ method: string; url: string }> = [];
  source.ctx.backupFetch = async (input, init) => {
    const req = new Request(input, init);
    destRequests.push({ method: req.method, url: req.url });
    return handleS3(dest.ctx, req, `req_${crypto.randomUUID()}`);
  };

  const owner = source.seedUser("owner@x.com");
  const ownerCred = source.seedCredential(owner.id);
  expect((await source.signAndSend({ method: "PUT", path: "/photos", ...ownerCred })).status).toBe(200);
  const putObject = async (key: string, body: string | Uint8Array, headers?: Record<string, string>) => {
    const res = await source.signAndSend({ method: "PUT", path: `/photos/${key}`, body, headers, ...ownerCred });
    expect(res.status).toBe(200);
  };

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

  const s3Input = (overrides: Record<string, unknown> = {}) => ({
    kind: "s3",
    endpoint: DEST_ENDPOINT,
    region: "us-east-1",
    bucket: "offsite",
    prefix: "gateway",
    forcePathStyle: true,
    accessKeyId: destCred.accessKeyId,
    secretAccessKey: destCred.secretAccessKey,
    ...overrides,
  });

  const addDestination = async (input: Record<string, unknown>) => {
    const res = await api("POST", "/api/backup-accounts", input);
    const body = await read<Destination>(res);
    expect(res.status, JSON.stringify(body.error)).toBe(201);
    return body.data!;
  };

  const bucketId = () => source.ctx.repos.buckets.listByName("photos")[0]!.id;

  const runBackup = async (destinationId: string) => {
    const res = await api("POST", `/api/buckets/${bucketId()}/backups`, { backupAccountId: destinationId });
    const started = await read<{ id: string }>(res);
    expect(res.status, JSON.stringify(started.error)).toBe(202);
    const worker = new BackupTransferWorker(source.ctx);
    for (let i = 0; i < 100; i++) {
      if (!(await worker.runOnce()).processed) break;
    }
    return source.ctx.repos.backupTransfers.findById(started.data!.id)!;
  };

  const ledger = (transferId: string) =>
    source.ctx.repos.backupTransfers.listTransferObjects(transferId, { limit: 100 });

  const destGet = (key: string) => dest.signAndSend({ method: "GET", path: `/offsite/${key}`, ...destCred });

  return { source, dest, destCred, destRequests, putObject, api, s3Input, addDestination, runBackup, ledger, destGet };
}

describe("adding an S3 destination", () => {
  test("is checked with a real write before it is saved, and never echoes the secret", async () => {
    const { api, s3Input, addDestination, destGet, destCred } = await setup();

    const added = await addDestination(s3Input());
    expect(added.kind).toBe("s3");
    expect(added.status).toBe("active");
    expect(added.label).toBe("offsite/gateway · dest.test");
    expect(added.config).toMatchObject({ endpoint: DEST_ENDPOINT, bucket: "offsite", prefix: "gateway" });

    const marker = await destGet("gateway/.drives3-backup.json");
    expect(marker.status).toBe(200);
    expect(JSON.parse(await marker.text())).toMatchObject({ service: "drives3-backup", destinationId: added.id });

    const listed = await (await api("GET", "/api/backup-accounts")).text();
    expect(listed).not.toContain(destCred.secretAccessKey);
    expect(listed).not.toContain(destCred.accessKeyId);
  });

  test("a key the destination rejects is reported with its reason, and nothing is saved", async () => {
    const { api, s3Input } = await setup();

    const res = await api("POST", "/api/backup-accounts", s3Input({ secretAccessKey: "not-the-secret" }));
    expect(res.status).toBe(422);
    const body = await read<never>(res);
    expect(body.error?.code).toBe("BACKUP_DESTINATION_UNREACHABLE");
    expect(body.error?.detail).toContain("SignatureDoesNotMatch");

    const listed = await read<Destination[]>(await api("GET", "/api/backup-accounts"));
    expect(listed.data).toEqual([]);
  });

  test("invalid settings are refused before anything is contacted", async () => {
    const { api, s3Input, destRequests } = await setup();

    for (const input of [
      s3Input({ endpoint: "ftp://dest.test" }),
      s3Input({ endpoint: "https://dest.test/some/path" }),
      s3Input({ prefix: "a/../b" }),
      s3Input({ bucket: "Has_Underscore", forcePathStyle: false }),
      s3Input({ secretAccessKey: "" }),
      { kind: "ftp" },
    ]) {
      const res = await api("POST", "/api/backup-accounts", input);
      expect(res.status).toBe(400);
      const body = await read<never>(res);
      expect(body.error?.code).toBe("INVALID_BACKUP_DESTINATION");
      expect(body.error?.detail?.length).toBeGreaterThan(0);
    }
    expect(destRequests).toEqual([]);
  });

  test("a private endpoint is refused unless the operator allows it", async () => {
    const { source, api, s3Input } = await setup();
    source.ctx.config.backupDestinations.s3AllowPrivateEndpoints = false;

    for (const endpoint of ["https://127.0.0.1:9000", "https://169.254.169.254", "https://[::1]"]) {
      const res = await api("POST", "/api/backup-accounts", s3Input({ endpoint }));
      const body = await read<never>(res);
      expect(res.status, endpoint).toBe(422);
      expect(body.error?.detail).toContain("private or local address");
    }
    // And plain http is not even an option then.
    const http = await api("POST", "/api/backup-accounts", s3Input({ endpoint: "http://example.com" }));
    expect(http.status).toBe(400);
  });
});

describe("backing up to S3", () => {
  test("copies every object with its metadata, then skips what is unchanged", async () => {
    const { putObject, addDestination, s3Input, runBackup, ledger, destGet, source } = await setup();
    await putObject("cats/tabby.txt", "meow", {
      "content-type": "text/plain",
      "x-amz-meta-colour": "orange",
    });
    await putObject("dogs/rex.json", '{"good":true}', { "content-type": "application/json" });
    await putObject("readme.md", "# photos");
    const destination = await addDestination(s3Input());

    const first = await runBackup(destination.id);
    expect(first.status).toBe("completed");
    expect(first.copied_count).toBe(3);
    expect(first.failed_count).toBe(0);

    const tabby = await destGet("gateway/photos/cats/tabby.txt");
    expect(tabby.status).toBe(200);
    expect(await tabby.text()).toBe("meow");
    expect(tabby.headers.get("content-type")).toBe("text/plain");
    expect(tabby.headers.get("x-amz-meta-colour")).toBe("orange");
    const sourceObject = source.ctx.repos.objects.findByKey(
      source.ctx.repos.buckets.listByName("photos")[0]!.id,
      "cats/tabby.txt",
    )!;
    expect(tabby.headers.get("x-amz-meta-drives3-etag")).toBe(sourceObject.etag);
    expect(await (await destGet("gateway/photos/dogs/rex.json")).text()).toBe('{"good":true}');

    expect(ledger(first.id).map((line) => line.destination_file_id).sort()).toEqual([
      "gateway/photos/cats/tabby.txt",
      "gateway/photos/dogs/rex.json",
      "gateway/photos/readme.md",
    ]);

    const second = await runBackup(destination.id);
    expect(second.status).toBe("completed");
    expect(second.skipped_count).toBe(3);
    expect(second.copied_count).toBe(0);
  });

  test("a changed object overwrites its copy instead of adding another", async () => {
    const { putObject, addDestination, s3Input, runBackup, destGet } = await setup();
    await putObject("notes.txt", "first draft");
    const destination = await addDestination(s3Input());
    await runBackup(destination.id);

    await putObject("notes.txt", "second draft");
    const rerun = await runBackup(destination.id);
    expect(rerun.copied_count).toBe(1);
    expect(await (await destGet("gateway/photos/notes.txt")).text()).toBe("second draft");
  });

  test("an object larger than a part goes up as a multipart upload", async () => {
    const { putObject, addDestination, s3Input, runBackup, destGet, destRequests } = await setup({
      partSizeBytes: 5 * MIB,
    });
    const big = new Uint8Array(11 * MIB);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) % 251;
    await putObject("video.bin", big);
    const destination = await addDestination(s3Input());

    const run = await runBackup(destination.id);
    expect(run.status).toBe("completed");
    expect(run.copied_count).toBe(1);

    const copy = new Uint8Array(await (await destGet("gateway/photos/video.bin")).arrayBuffer());
    expect(copy.length).toBe(big.length);
    expect(Buffer.from(copy).equals(Buffer.from(big))).toBe(true);
    const parts = destRequests.filter((r) => r.method === "PUT" && r.url.includes("partNumber="));
    expect(parts).toHaveLength(3);
    expect(destRequests.some((r) => r.method === "POST" && r.url.includes("uploads="))).toBe(true);
  });

  test("an SSE object arrives decrypted; an SSE-C one fails on its own", async () => {
    const { putObject, addDestination, s3Input, runBackup, ledger, destGet } = await setup();
    await putObject("secret.txt", "plaintext inside", { "x-amz-server-side-encryption": "AES256" });
    const customerKey = Buffer.alloc(32, 9);
    await putObject("customer.txt", "theirs", {
      "x-amz-server-side-encryption-customer-algorithm": "AES256",
      "x-amz-server-side-encryption-customer-key": customerKey.toString("base64"),
      "x-amz-server-side-encryption-customer-key-md5": new Bun.CryptoHasher("md5")
        .update(customerKey)
        .digest("base64"),
    });
    const destination = await addDestination(s3Input());

    const run = await runBackup(destination.id);
    expect(run.copied_count).toBe(1);
    expect(run.failed_count).toBe(1);
    expect(await (await destGet("gateway/photos/secret.txt")).text()).toBe("plaintext inside");
    const failed = ledger(run.id).find((line) => line.status === "failed")!;
    expect(failed.object_key).toBe("customer.txt");
    expect(failed.last_error).toContain("SSE-C");
  });

  test("revoked credentials stop the run and flag the destination; new ones bring it back", async () => {
    const { source, dest, destCred, putObject, addDestination, s3Input, runBackup, ledger, api } = await setup();
    await putObject("a.txt", "a");
    await putObject("b.txt", "b");
    const destination = await addDestination(s3Input());

    const credential = dest.ctx.repos.credentials.findActiveByAccessKeyId(destCred.accessKeyId)!;
    dest.ctx.repos.credentials.revoke(credential.user_id, credential.id);

    const failed = await runBackup(destination.id);
    expect(failed.status).toBe("failed");
    expect(failed.last_error).toContain("InvalidAccessKeyId");
    // The objects did nothing wrong, so none of them used up a retry.
    expect(ledger(failed.id)).toEqual([]);
    const flagged = source.ctx.repos.backupAccounts.findById(destination.id)!;
    expect(flagged.status).toBe("error");

    const fresh = dest.seedCredential(credential.user_id);
    const patched = await api("PATCH", `/api/backup-accounts/${destination.id}`, {
      accessKeyId: fresh.accessKeyId,
      secretAccessKey: fresh.secretAccessKey,
    });
    expect(patched.status).toBe(200);
    expect((await read<Destination>(patched)).data!.status).toBe("active");

    const recovered = await runBackup(destination.id);
    expect(recovered.status).toBe("completed");
    expect(recovered.copied_count).toBe(2);
  });

  test("a destination's location cannot be edited in place", async () => {
    const { api, addDestination, s3Input } = await setup();
    const destination = await addDestination(s3Input());

    const moved = await api("PATCH", `/api/backup-accounts/${destination.id}`, { prefix: "elsewhere" });
    expect(moved.status).toBe(400);
    expect((await read<never>(moved)).error?.detail).toContain("prefix cannot be changed");

    const renamed = await api("PATCH", `/api/backup-accounts/${destination.id}`, { label: "Offsite vault" });
    expect(renamed.status).toBe(200);
    expect((await read<Destination>(renamed)).data!.label).toBe("Offsite vault");
  });

  test("the test endpoint re-checks a saved destination and records the outcome", async () => {
    const { dest, destCred, api, addDestination, s3Input } = await setup();
    const destination = await addDestination(s3Input());

    const healthy = await read<{ healthy: boolean }>(
      await api("POST", `/api/backup-accounts/${destination.id}/test`),
    );
    expect(healthy.data!.healthy).toBe(true);

    const credential = dest.ctx.repos.credentials.findActiveByAccessKeyId(destCred.accessKeyId)!;
    dest.ctx.repos.credentials.revoke(credential.user_id, credential.id);
    const broken = await read<{ healthy: boolean; error: string; account: Destination }>(
      await api("POST", `/api/backup-accounts/${destination.id}/test`),
    );
    expect(broken.data!.healthy).toBe(false);
    expect(broken.data!.error).toContain("InvalidAccessKeyId");
    expect(broken.data!.account.status).toBe("error");
  });

  test("history names the destination by its label and kind", async () => {
    const { api, putObject, addDestination, s3Input, runBackup } = await setup();
    await putObject("a.txt", "a");
    const destination = await addDestination(s3Input({ label: "R2 vault" }));
    await runBackup(destination.id);

    const history = await read<{ items: Array<{ accountLabel: string; accountKind: string }> }>(
      await api("GET", "/api/backups"),
    );
    expect(history.data!.items[0]).toMatchObject({ accountLabel: "R2 vault", accountKind: "s3" });
    const summary = await read<{ accounts: Array<{ label: string; kind: string }> }>(
      await api("GET", "/api/backups/summary"),
    );
    expect(summary.data!.accounts[0]).toMatchObject({ label: "R2 vault", kind: "s3" });
  });
});

/** A stand-in for rclone that understands only what the sink sends:
 *  `[--config FILE] rcat --size N remote:path`. */
function fakeRclone(): { binary: string; root: string } {
  const dir = mkdtempSync(join(tmpdir(), "drives3-fake-rclone-"));
  tempDirs.push(dir);
  const root = join(dir, "remotes");
  const binary = join(dir, "rclone");
  writeFileSync(
    binary,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "--config" ]; then shift 2; fi
[ "$1" = "rcat" ] || { echo "unsupported: $*" >&2; exit 1; }
shift
if [ "$1" = "--size" ]; then shift 2; fi
target="$1"; remote="\${target%%:*}"; path="\${target#*:}"
if [ "$remote" = "broken" ]; then
  echo "Failed to create file system for \\"$target\\": didn't find section in config file" >&2
  exit 1
fi
dest="$RCLONE_FAKE_ROOT/$remote/$path"
mkdir -p "$(dirname "$dest")"
cat > "$dest"
`,
  );
  chmodSync(binary, 0o755);
  process.env.RCLONE_FAKE_ROOT = root;
  return { binary, root };
}

describe("backing up through rclone", () => {
  test("only the operator's remotes are offered, and copies land under path/bucket/key", async () => {
    const rclone = fakeRclone();
    const { api, putObject, addDestination, runBackup, ledger } = await setup({
      rcloneRemotes: ["nas"],
      rcloneBinary: rclone.binary,
    });
    await putObject("cats/tabby.txt", "meow");

    const options = await read<{ rclone: { remotes: string[]; binaryFound: boolean } }>(
      await api("GET", "/api/backup-accounts/options"),
    );
    expect(options.data!.rclone).toEqual({ remotes: ["nas"], binaryFound: true });

    const destination = await addDestination({ kind: "rclone", remote: "nas", path: "backups/gateway" });
    expect(destination).toMatchObject({ kind: "rclone", label: "nas:backups/gateway" });
    expect(existsSync(join(rclone.root, "nas/backups/gateway/.drives3-backup.json"))).toBe(true);

    const run = await runBackup(destination.id);
    expect(run.status).toBe("completed");
    expect(readFileSync(join(rclone.root, "nas/backups/gateway/photos/cats/tabby.txt"), "utf8")).toBe("meow");
    expect(ledger(run.id)[0]!.destination_file_id).toBe("nas:backups/gateway/photos/cats/tabby.txt");
  });

  test("a remote that is not on the allowlist, or a path that climbs out, is refused", async () => {
    const rclone = fakeRclone();
    const { api } = await setup({ rcloneRemotes: ["nas"], rcloneBinary: rclone.binary });

    for (const input of [
      { kind: "rclone", remote: "local", path: "etc" },
      { kind: "rclone", remote: "nas", path: "../outside" },
      { kind: "rclone", remote: "nas", path: "/absolute" },
    ]) {
      const res = await api("POST", "/api/backup-accounts", input);
      expect(res.status, JSON.stringify(input)).toBe(400);
    }
  });

  test("an rclone failure is reported with rclone's own words", async () => {
    const rclone = fakeRclone();
    const { api } = await setup({ rcloneRemotes: ["broken"], rcloneBinary: rclone.binary });

    const res = await api("POST", "/api/backup-accounts", { kind: "rclone", remote: "broken", path: "" });
    expect(res.status).toBe(422);
    expect((await read<never>(res)).error?.detail).toContain("didn't find section in config file");
  });

  test("taking a remote off the allowlist stops destinations already saved against it", async () => {
    const rclone = fakeRclone();
    const { source, putObject, addDestination, runBackup } = await setup({
      rcloneRemotes: ["nas"],
      rcloneBinary: rclone.binary,
    });
    await putObject("a.txt", "a");
    const destination = await addDestination({ kind: "rclone", remote: "nas", path: "" });

    source.ctx.config.backupDestinations.rcloneRemotes = [];
    const run = await runBackup(destination.id);
    expect(run.status).toBe("failed");
    expect(run.last_error).toContain("no longer offered");
    expect(source.ctx.repos.backupAccounts.findById(destination.id)!.status).toBe("error");
  });

  test("a key with an empty path segment fails alone", async () => {
    const rclone = fakeRclone();
    const { putObject, addDestination, runBackup, ledger } = await setup({
      rcloneRemotes: ["nas"],
      rcloneBinary: rclone.binary,
    });
    await putObject("ok.txt", "fine");
    await putObject("odd//name.txt", "double slash");
    const destination = await addDestination({ kind: "rclone", remote: "nas", path: "" });

    const run = await runBackup(destination.id);
    expect(run.status).toBe("completed");
    expect(run.copied_count).toBe(1);
    expect(run.failed_count).toBe(1);
    const failed = ledger(run.id).find((line) => line.status === "failed")!;
    expect(failed.object_key).toBe("odd//name.txt");
  });
});
