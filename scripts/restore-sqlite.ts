#!/usr/bin/env bun
// CLI: restore an encrypted SQLite backup atomically.

import { encryptionKeyFromBase64, restoreEncryptedBackup } from "./backup-core.ts";

const args = parseArgs(process.argv.slice(2));
if (!args.input) throw new Error("--input is required");
const targetPath = args.target ?? process.env.SQLITE_PATH ?? "./data/app.sqlite";
const key = encryptionKeyFromBase64(process.env.MASTER_ENCRYPTION_KEY);
const result = restoreEncryptedBackup({
  encryptedPath: args.input,
  targetPath,
  key,
  force: args.force,
});
process.stdout.write(JSON.stringify(result, null, 2) + "\n");

function parseArgs(argv: string[]): { input?: string; target?: string; force?: boolean } {
  const out: { input?: string; target?: string; force?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input" && argv[i + 1]) out.input = argv[++i];
    else if (argv[i] === "--target" && argv[i + 1]) out.target = argv[++i];
    else if (argv[i] === "--force") out.force = true;
    else if (argv[i] === "--help" || argv[i] === "-h") {
      process.stdout.write(
        "Usage: bun scripts/restore-sqlite.ts --input BACKUP [--target DB] [--force]\n" +
          "Requires the same MASTER_ENCRYPTION_KEY used for backup.\n",
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}
