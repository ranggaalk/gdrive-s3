#!/usr/bin/env bun
// CLI: create an encrypted SQLite snapshot.

import { createEncryptedBackup, encryptionKeyFromBase64 } from "./backup-core.ts";

const args = parseArgs(process.argv.slice(2));
const sourcePath = args.source ?? process.env.SQLITE_PATH ?? "./data/app.sqlite";
const outputDir = args.out ?? "./backups";
const key = encryptionKeyFromBase64(process.env.MASTER_ENCRYPTION_KEY);
const result = createEncryptedBackup({ sourcePath, outputDir, key });
process.stdout.write(JSON.stringify(result, null, 2) + "\n");

function parseArgs(argv: string[]): { source?: string; out?: string } {
  const out: { source?: string; out?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source" && argv[i + 1]) out.source = argv[++i];
    else if (argv[i] === "--out" && argv[i + 1]) out.out = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      process.stdout.write(
        "Usage: bun scripts/backup-sqlite.ts [--source DB] [--out DIR]\n" +
          "Requires MASTER_ENCRYPTION_KEY (base64, exactly 32 bytes).\n",
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}
