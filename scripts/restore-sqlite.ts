#!/usr/bin/env bun
// CLI: restore an encrypted SQLite backup atomically. Without
// MASTER_ENCRYPTION_KEY (or with --passphrase) it restores from the archive's
// key recovery instead, and prints the recovered key for the new environment.

import { writeFileSync } from "node:fs";
import {
  backupHasKeyRecovery,
  encryptionKeyFromBase64,
  restoreEncryptedBackup,
} from "./backup-core.ts";
import { promptHidden } from "./prompt.ts";

const args = parseArgs(process.argv.slice(2));
if (!args.input) throw new Error("--input is required");
const targetPath = args.target ?? process.env.SQLITE_PATH ?? "./data/app.sqlite";
const envKey = process.env.MASTER_ENCRYPTION_KEY;

let result;
if (args.passphrase || !envKey) {
  if (!backupHasKeyRecovery(args.input)) {
    throw new Error(
      envKey
        ? "this backup carries no key recovery; restore it with MASTER_ENCRYPTION_KEY"
        : "MASTER_ENCRYPTION_KEY is not set and this backup carries no key recovery, " +
            "so only the original key can restore it",
    );
  }
  const passphrase = process.env.BACKUP_PASSPHRASE || (await promptHidden("Recovery passphrase: "));
  result = restoreEncryptedBackup({ encryptedPath: args.input, targetPath, passphrase, force: args.force });
} else {
  result = restoreEncryptedBackup({
    encryptedPath: args.input,
    targetPath,
    key: encryptionKeyFromBase64(envKey),
    force: args.force,
  });
}

const { recoveredKey, ...summary } = result;
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");

if (recoveredKey) {
  const line = `MASTER_ENCRYPTION_KEY=${recoveredKey.toString("base64")}\n`;
  if (args.keyOut) {
    writeFileSync(args.keyOut, line, { mode: 0o600, flag: "wx" });
    process.stderr.write(`Recovered MASTER_ENCRYPTION_KEY written to ${args.keyOut}\n`);
  } else {
    // stderr, so the JSON summary on stdout can be piped or logged without it.
    process.stderr.write(
      "\nRecovered the master key. The gateway needs it to read this database --\n" +
        "set it in the environment before starting:\n\n  " +
        line +
        "\n",
    );
  }
}

function parseArgs(argv: string[]): {
  input?: string;
  target?: string;
  force?: boolean;
  passphrase?: boolean;
  keyOut?: string;
} {
  const out: { input?: string; target?: string; force?: boolean; passphrase?: boolean; keyOut?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input" && argv[i + 1]) out.input = argv[++i];
    else if (argv[i] === "--target" && argv[i + 1]) out.target = argv[++i];
    else if (argv[i] === "--force") out.force = true;
    else if (argv[i] === "--passphrase") out.passphrase = true;
    else if (argv[i] === "--key-out" && argv[i + 1]) out.keyOut = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      process.stdout.write(
        "Usage: bun scripts/restore-sqlite.ts --input BACKUP [--target DB] [--force]\n" +
          "                                    [--passphrase] [--key-out FILE]\n" +
          "Uses MASTER_ENCRYPTION_KEY when it is set. Without it (or with --passphrase),\n" +
          "restores from the archive's key recovery: asks for the passphrase (or reads\n" +
          "BACKUP_PASSPHRASE) and prints the recovered key, or writes it to --key-out.\n",
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}
