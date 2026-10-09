// Adds, edits and checks the S3 and rclone backup destinations. (A Drive
// destination is linked through Google's consent screen instead; see
// backup-account-service.ts.) Nothing is saved until the destination has
// accepted a write, so a typo in a key or bucket name surfaces here rather than
// as a failed run later.

import type { AppContext } from "../context.ts";
import type { BackupAccountRow } from "../db/repositories/backup-accounts.ts";
import {
  DestinationInputError,
  parseLabelUpdate,
  parseRcloneInput,
  parseS3Input,
  readS3Config,
  validateAccessKeyId,
  validateSecretAccessKey,
} from "../backup/destination-config.ts";
import { createDestinationProbe, rcloneSink, s3Sink } from "../backup/destinations.ts";
import type { DestinationProbe } from "../backup/sink.ts";
import { aad, sealToString } from "../security/encryption.ts";
import { newBackupAccountId } from "../util/ids.ts";

/** How long a connection check may take before it counts as a failure. */
const CHECK_TIMEOUT_MS = 30_000;

/** The destination was reachable as configured -- or it was not, and why. */
export class DestinationCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DestinationCheckError";
  }
}

export class DestinationNotFoundError extends Error {}

export interface DestinationOptions {
  s3: { allowPrivateEndpoints: boolean };
  rclone: { remotes: string[]; binaryFound: boolean };
}

export class BackupDestinationService {
  constructor(private readonly ctx: AppContext) {}

  options(): DestinationOptions {
    const settings = this.ctx.config.backupDestinations;
    return {
      s3: { allowPrivateEndpoints: settings.s3AllowPrivateEndpoints },
      rclone: {
        remotes: settings.rcloneRemotes,
        binaryFound: settings.rcloneRemotes.length > 0 && Bun.which(settings.rcloneBinary) !== null,
      },
    };
  }

  async create(ownerUserId: string, input: unknown, signal?: AbortSignal): Promise<BackupAccountRow> {
    const kind = (input as { kind?: unknown } | null)?.kind;
    const settings = this.ctx.config.backupDestinations;
    const id = newBackupAccountId();

    if (kind === "s3") {
      const parsed = parseS3Input(input, settings);
      await this.check(s3Sink(this.ctx, id, parsed.config, parsed.secretAccessKey), signal);
      return this.ctx.repos.backupAccounts.createDestination({
        id,
        ownerUserId,
        kind,
        label: parsed.label,
        configJson: JSON.stringify(parsed.config),
        encryptedSecret: this.sealSecret(id, parsed.secretAccessKey),
      });
    }
    if (kind === "rclone") {
      const parsed = parseRcloneInput(input, settings);
      await this.check(rcloneSink(this.ctx, id, parsed.config), signal);
      return this.ctx.repos.backupAccounts.createDestination({
        id,
        ownerUserId,
        kind,
        label: parsed.label,
        configJson: JSON.stringify(parsed.config),
        encryptedSecret: null,
      });
    }
    throw new DestinationInputError('kind must be "s3" or "rclone"');
  }

  /**
   * A new label, or (for S3) a new key pair. Never the location: copies
   * already on record are at the old one, and the ledger would vouch for them
   * at the new one. Moving means adding a new destination.
   */
  async update(
    ownerUserId: string,
    id: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<{ account: BackupAccountRow; rotatedCredentials: boolean }> {
    const account = this.ctx.repos.backupAccounts.findOwned(ownerUserId, id);
    if (!account) throw new DestinationNotFoundError();
    if (account.kind === "drive") {
      throw new DestinationInputError("a Drive destination is named after its Google account");
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new DestinationInputError("expected a JSON object");
    }
    const raw = input as Record<string, unknown>;
    const unexpected = Object.keys(raw).filter(
      (key) => !["label", "accessKeyId", "secretAccessKey"].includes(key),
    );
    if (unexpected.length > 0) {
      throw new DestinationInputError(
        `${unexpected.join(", ")} cannot be changed; add a new destination to back up somewhere else`,
      );
    }
    const label = parseLabelUpdate(raw, account.email);

    const wantsRotation = raw.accessKeyId !== undefined || raw.secretAccessKey !== undefined;
    if (!wantsRotation) {
      this.ctx.repos.backupAccounts.updateDestination(id, { label });
      return { account: this.ctx.repos.backupAccounts.findById(id)!, rotatedCredentials: false };
    }
    if (account.kind !== "s3") throw new DestinationInputError("only an S3 destination has credentials to change");
    if (typeof raw.accessKeyId !== "string" || typeof raw.secretAccessKey !== "string") {
      throw new DestinationInputError("accessKeyId and secretAccessKey must be changed together");
    }
    const accessKeyId = validateAccessKeyId(raw.accessKeyId.trim());
    const secretAccessKey = validateSecretAccessKey(raw.secretAccessKey.trim());
    if (!accessKeyId || !secretAccessKey) {
      throw new DestinationInputError("accessKeyId and secretAccessKey are required");
    }
    const config = { ...readS3Config(account.config_json), accessKeyId };
    await this.check(s3Sink(this.ctx, id, config, secretAccessKey), signal);
    this.ctx.repos.backupAccounts.updateDestination(id, {
      label,
      configJson: JSON.stringify(config),
      encryptedSecret: this.sealSecret(id, secretAccessKey),
    });
    this.ctx.repos.backupAccounts.markActive(id);
    return { account: this.ctx.repos.backupAccounts.findById(id)!, rotatedCredentials: true };
  }

  /** Re-checks a saved destination and records the outcome on it. */
  async test(ownerUserId: string, id: string, signal?: AbortSignal): Promise<{ account: BackupAccountRow; error: string | null }> {
    const account = this.ctx.repos.backupAccounts.findOwned(ownerUserId, id);
    if (!account) throw new DestinationNotFoundError();
    let error: string | null = null;
    try {
      if (account.kind === "drive") {
        // Refreshing the token is the whole check, and it records itself.
        this.ctx.backupTokenProvider.invalidate(id);
        await this.ctx.backupTokenProvider.getAccessToken(id, signal);
      } else {
        await this.check(createDestinationProbe(this.ctx, account)!, signal);
        this.ctx.repos.backupAccounts.markActive(id);
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      if (account.kind !== "drive") this.ctx.repos.backupAccounts.markError(id, "error", error);
    }
    return { account: this.ctx.repos.backupAccounts.findById(id)!, error };
  }

  private async check(probe: DestinationProbe, signal?: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(CHECK_TIMEOUT_MS);
    try {
      await probe.check(signal ? AbortSignal.any([signal, timeout]) : timeout);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted) {
        throw new DestinationCheckError(`no answer within ${CHECK_TIMEOUT_MS / 1000} seconds`);
      }
      throw new DestinationCheckError(error instanceof Error ? error.message : String(error));
    }
  }

  private sealSecret(id: string, secret: string): string {
    return sealToString(secret, this.ctx.config.masterEncryptionKey, aad.backupDestinationSecret(id));
  }
}
