// Writes an encrypted archive of the gateway's database by running the same
// db:backup tool an operator would, in a child process.
//
// In a child, not in the server: making an archive is synchronous, CPU-heavy
// work -- VACUUM INTO, gzip at level 9, a scrypt that takes ~128 MiB on
// purpose -- that would otherwise stall every S3 request while it ran. And
// because it is the very same tool, a scheduled archive is byte-for-byte the
// kind `db:restore` already knows.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The parts of the tool's JSON output this side uses. */
export interface DbArchive {
  encryptedPath: string;
  manifestPath: string;
  manifest: {
    createdAt: string;
    encryptedFile: string;
    sha256: string;
    bytes: number;
    migrationVersion: number;
    keyRecovery: "passphrase" | "none";
  };
}

/**
 * Where the tool is: beside the bundled server in a build (dist/server ->
 * dist/scripts, which the Docker image ships), or in the checkout's scripts/
 * when running from source. BACKUP_SQLITE_SCRIPT overrides both for other
 * packaging, as MIGRATIONS_DIR does for migrations.
 */
export function backupToolPath(): string {
  const override = process.env.BACKUP_SQLITE_SCRIPT;
  if (override) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "../scripts/backup-sqlite.js"), join(here, "../../../../scripts/backup-sqlite.ts")];
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(`the db:backup tool was not found (looked in ${candidates.join(", ")}); set BACKUP_SQLITE_SCRIPT`);
  }
  return found;
}

export async function writeDbArchive(input: {
  sqlitePath: string;
  outDir: string;
  masterKey: Buffer;
  /** With one, the archive also carries the master key, wrapped under it. */
  passphrase: string | null;
  signal?: AbortSignal;
}): Promise<DbArchive> {
  input.signal?.throwIfAborted();
  const cmd = [
    process.execPath,
    backupToolPath(),
    "--source",
    input.sqlitePath,
    "--out",
    input.outDir,
    ...(input.passphrase ? [] : ["--no-recovery"]),
  ];
  // Only what the tool reads. The key travels by environment, as it does
  // for an operator running the tool by hand -- never on the command line,
  // where `ps` would show it.
  const env: Record<string, string> = {
    MASTER_ENCRYPTION_KEY: input.masterKey.toString("base64"),
  };
  for (const name of ["PATH", "HOME", "TMPDIR", "MIGRATIONS_DIR"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  if (input.passphrase) env.BACKUP_PASSPHRASE = input.passphrase;

  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
  const kill = () => proc.kill();
  input.signal?.addEventListener("abort", kill, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    input.signal?.throwIfAborted();
    if (code !== 0) {
      // Bun prints an uncaught error as source context, then "error: <message>".
      const message = /^error: (.+)$/m.exec(stderr)?.[1] ?? stderr.trim().split("\n").pop() ?? "";
      throw new Error(`db:backup failed (exit ${code})${message ? `: ${message}` : ""}`);
    }
    return JSON.parse(stdout) as DbArchive;
  } finally {
    input.signal?.removeEventListener("abort", kill);
  }
}
