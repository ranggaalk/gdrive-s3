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
      meteredFetch(this.ctx.driveQuotaMeter, account.owner_user_id),
    );
  }

  /** Idempotently ensure the destination's root folder exists; cached on the account row. */
  async ensureRootFolder(account: BackupAccountRow, signal?: AbortSignal): Promise<string> {
    if (account.root_folder_id) return account.root_folder_id;
    const client = await this.client(account, signal);
    const marker = `backup-root:${account.id}`;
    const existing = await client.findByAppProperty(MARKER_KEY, marker, signal);
    if (existing) {
      this.ctx.repos.backupAccounts.setRootFolder(account.id, existing.id);
      return existing.id;
    }
    const created = await client.createFolder(
      this.ctx.runtimeSettings.getRootFolderName(),
      { [MARKER_KEY]: "backup_root", drives3BackupOwnerId: account.owner_user_id },
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
    const marker = `backup-bucket:${account.id}:${bucket.id}`;
    const existing = await client.findByAppProperty(MARKER_KEY, marker, signal, undefined, rootFolderId);
    if (existing) return existing.id;
    const created = await client.createFolder(
      `${bucket.name} [${bucket.id}]`,
      { [MARKER_KEY]: "backup_bucket", drives3BackupBucketId: bucket.id },
      rootFolderId,
      signal,
    );
    return created.id;
  }
}
