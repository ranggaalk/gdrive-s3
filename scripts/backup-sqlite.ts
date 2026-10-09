#!/usr/bin/env bun
// CLI: create an encrypted SQLite snapshot. With a recovery passphrase the
// archive also carries MASTER_ENCRYPTION_KEY, wrapped under that passphrase.

import {
  createEncryptedBackup,
  encryptionKeyFromBase64,
  MIN_RECOVERY_PASSPHRASE_LENGTH,
} from "./backup-core.ts";
import { promptHidden } from "./prompt.ts";

const args = parseArgs(process.argv.slice(2));
const sourcePath = args.source ?? process.env.SQLITE_PATH ?? "./data/app.sqlite";
const outputDir = args.out ?? "./backups";
const key = encryptionKeyFromBase64(process.env.MASTER_ENCRYPTION_KEY);
const recoveryPassphrase = await resolvePassphrase(args.noRecovery ?? false);
const result = createEncryptedBackup({ sourcePath, outputDir, key, recoveryPassphrase });
process.stdout.write(JSON.stringify(result, null, 2) + "\n");

/**
 * BACKUP_PASSPHRASE serves scheduled backups. A host that can read it can read
 * MASTER_ENCRYPTION_KEY too, so keeping it there costs nothing -- but it only
 * helps a lost-key redeploy if a copy also lives somewhere else.
 */
async function resolvePassphrase(noRecovery: boolean): Promise<string | undefined> {
  if (noRecovery) return undefined;
  const fromEnv = process.env.BACKUP_PASSPHRASE;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    // Unattended and unconfigured: keep backing up as before rather than
    // failing a cron job that predates key recovery.
    process.stderr.write(
      "warning: BACKUP_PASSPHRASE is not set and there is no terminal to ask for it; " +
        "this backup can only be restored with MASTER_ENCRYPTION_KEY\n",
    );
    return undefined;
  }
  const first = await promptHidden(
    `Recovery passphrase (at least ${MIN_RECOVERY_PASSPHRASE_LENGTH} characters): `,
  );
  if (!first) throw new Error("no passphrase entered; pass --no-recovery to back up without one");
  if ([...first.normalize("NFKC")].length < MIN_RECOVERY_PASSPHRASE_LENGTH) {
    throw new Error(`the recovery passphrase must be at least ${MIN_RECOVERY_PASSPHRASE_LENGTH} characters`);
  }
  const second = await promptHidden("Repeat the passphrase: ");
  if (first !== second) throw new Error("the passphrases do not match");
  return first;
}

function parseArgs(argv: string[]): { source?: string; out?: string; noRecovery?: boolean } {
  const out: { source?: string; out?: string; noRecovery?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source" && argv[i + 1]) out.source = argv[++i];
    else if (argv[i] === "--out" && argv[i + 1]) out.out = argv[++i];
    else if (argv[i] === "--no-recovery") out.noRecovery = true;
    else if (argv[i] === "--help" || argv[i] === "-h") {
      process.stdout.write(
        "Usage: bun scripts/backup-sqlite.ts [--source DB] [--out DIR] [--no-recovery]\n" +
          "Requires MASTER_ENCRYPTION_KEY (base64, exactly 32 bytes).\n" +
          "Asks for a recovery passphrase (or reads BACKUP_PASSPHRASE) so the archive can\n" +
          "later be restored -- and the master key recovered -- with the passphrase alone.\n",
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}
