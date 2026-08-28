// Manages linked secondary Google Drive accounts used as manual backup
// destinations, and the folders created inside them.

import type { AccessibleBucketRow } from "../db/repositories/buckets.ts";
import type { BackupAccountRow } from "../db/repositories/backup-accounts.ts";
import { DriveClient } from "../drive/client.ts";
import { meteredFetch } from "../drive/metered-fetch.ts";
import { exchangeCode, verifyLinkedAccountIdToken } from "../auth/google-oauth.ts";
import { sealToString, aad } from "../security/encryption.ts";
import { newBackupAccountId } from "../util/ids.ts";
import type { AppContext } from "../context.ts";

const MARKER_KEY = "drives3Type";

// Identity properties the folder lookups match on. These must be the exact
// key/value pairs written at creation time: an earlier version searched
// `drives3Type` for "backup-root:<id>" while writing the constant
// "backup_root", so every lookup missed and every transfer created another
// folder alongside the last one.
const ROOT_ID_KEY = "drives3BackupRootFor";
const BUCKET_ID_KEY = "drives3BackupBucketFor";

/** Distinguishes a backup folder from an ordinary gateway root, which may sit
 *  in the very same account. Deliberately not the configurable gateway root
 *  name -- telling the two apart at a glance is the whole point. */
const BACKUP_FOLDER_PREFIX = "[DRIVE-S3-BACKUP]";

/**
 * Name of the backup root on the destination account.
 *
 * Derived only from values that never change, so the name is stable: rederiving
 * it on a later run must produce the same string, or the rename below would
 * fire on every transfer. `linkedAt` is when the account was linked, not now.
 */
export function backupRootFolderName(input: {
  ownerEmail: string | null;
  ownerUserId: string;
  linkedAt: string;
}): string {
  const day = input.linkedAt.slice(0, 10);
  const who = input.ownerEmail ?? input.ownerUserId;
  return `${BACKUP_FOLDER_PREFIX} ${who} ${day}`;
}

export class BackupLinkError extends Error {}

export class BackupAccountService {
  constructor(private readonly ctx: AppContext) {}

  async link(input: {
    ownerUserId: string;
    code: string;
    pkceVerifier: string;
    signal?: AbortSignal;
  }): Promise<BackupAccountRow> {
    const oauthCreds = this.ctx.runtimeSettings.getGoogleOAuthCredentials();
    let tokens;
    try {
      tokens = await exchangeCode(this.ctx.config, oauthCreds, input.code, input.pkceVerifier, input.signal);
    } catch {
      throw new BackupLinkError("Gagal menukar kode otorisasi dengan Google.");
    }
    if (!tokens.refresh_token) {
      throw new BackupLinkError(
        "Google tidak memberikan refresh token. Cabut akses aplikasi ini di Google Account lalu coba lagi.",
      );
    }
    const claims = await verifyLinkedAccountIdToken(oauthCreds, tokens.id_token, input.signal);

    const id = newBackupAccountId();
    const encrypted = sealToString(
      tokens.refresh_token,
      this.ctx.config.masterEncryptionKey,
      aad.backupRefreshToken(id),
    );
    return this.ctx.repos.backupAccounts.create({
      id,
      ownerUserId: input.ownerUserId,
      email: claims.email,
      encryptedRefreshToken: encrypted,
      grantedScopes: tokens.scope,
    });
  }

  unlink(ownerUserId: string, id: string): boolean {
    return this.ctx.repos.backupAccounts.delete(ownerUserId, id);
  }

  list(ownerUserId: string): BackupAccountRow[] {
    return this.ctx.repos.backupAccounts.listByOwner(ownerUserId);
  }

  private async client(account: BackupAccountRow, signal?: AbortSignal): Promise<DriveClient> {
    const token = await this.ctx.backupTokenProvider.getAccessToken(account.id, signal);
    // Backup accounts are separate Google accounts but share this gateway's
    // OAuth client, so their calls draw on the same project request quota and
    // are metered against the owner who linked them.
    return new DriveClient(
      token,
      this.ctx.config.driveRetryMaxAttempts,
      meteredFetch(this.ctx.driveQuotaMeter, account.owner_user_id, this.ctx.driveFetch),
    );
  }

  /** The name this account's backup root should carry. */
  private rootName(account: BackupAccountRow): string {
    return backupRootFolderName({
      ownerEmail: this.ctx.repos.users.findById(account.owner_user_id)?.email ?? null,
      ownerUserId: account.owner_user_id,
      linkedAt: account.created_at,
    });
  }

  /** Idempotently ensure the destination's root folder exists; cached on the account row. */
  async ensureRootFolder(account: BackupAccountRow, signal?: AbortSignal): Promise<string> {
    const client = await this.client(account, signal);
    const name = this.rootName(account);

    if (account.root_folder_id) {
      // Confirm the cached folder is still there. Someone tidying up duplicates
      // in Drive would otherwise leave a dead id here, and every later transfer
      // would upload into a folder that no longer exists.
      const current = await client.getFile(account.root_folder_id, signal);
      if (current && !current.trashed) {
        if (current.name !== name) await client.renameFile(current.id, name, signal);
        return current.id;
      }
      this.ctx.repos.backupAccounts.setRootFolder(account.id, null);
    }

    const existing = await client.findByAppProperty(ROOT_ID_KEY, account.id, signal);
    if (existing) {
      this.ctx.repos.backupAccounts.setRootFolder(account.id, existing.id);
      if (existing.name !== name) await client.renameFile(existing.id, name, signal);
      return existing.id;
    }

    const created = await client.createFolder(
      name,
      {
        [MARKER_KEY]: "backup_root",
        [ROOT_ID_KEY]: account.id,
        drives3BackupOwnerId: account.owner_user_id,
      },
      undefined,
      signal,
    );
    this.ctx.repos.backupAccounts.setRootFolder(account.id, created.id);
    return created.id;
  }

  /** Idempotently ensure a per-bucket subfolder exists under the destination's root. */
  async ensureBucketFolder(
    account: BackupAccountRow,
    bucket: AccessibleBucketRow,
    rootFolderId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const client = await this.client(account, signal);
    const existing = await client.findByAppProperty(
      BUCKET_ID_KEY,
      bucketMarker(account.id, bucket.id),
      signal,
      undefined,
      rootFolderId,
    );
    if (existing) return existing.id;
    const created = await client.createFolder(
      `${bucket.name} [${bucket.id}]`,
      {
        [MARKER_KEY]: "backup_bucket",
        [BUCKET_ID_KEY]: bucketMarker(account.id, bucket.id),
        drives3BackupBucketId: bucket.id,
      },
      rootFolderId,
      signal,
    );
    return created.id;
  }
}

/** Scoped to the account as well as the bucket: one bucket can be backed up to
 *  several destination accounts, each needing its own folder. */
export function bucketMarker(accountId: string, bucketId: string): string {
  return `${accountId}:${bucketId}`;
}
