// Access-token provider for linked backup accounts. Deliberately separate
// from TokenProvider (apps/server/src/drive/oauth-token.ts): it's keyed by
// backupAccountId instead of userId, and reads from BackupAccountsRepository
// instead of OAuthAccountsRepository — a linked backup account is a Drive
// grant, not an app login identity.

import type { AppConfig } from "../config.ts";
import { openFromString, aad } from "../security/encryption.ts";
import { refreshAccessToken } from "../auth/google-oauth.ts";
import { BackupAccountsRepository } from "../db/repositories/backup-accounts.ts";
import type { RuntimeSettingsService } from "../services/runtime-settings-service.ts";

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

export class BackupTokenRevokedError extends Error {
  constructor() {
    super("backup account refresh token revoked");
    this.name = "BackupTokenRevokedError";
  }
}

const EXPIRY_SKEW_MS = 60_000;

export class BackupTokenProvider {
  private cache = new Map<string, CachedToken>();

  constructor(
    private readonly config: AppConfig,
    private readonly accounts: BackupAccountsRepository,
    private readonly runtimeSettings: RuntimeSettingsService,
  ) {}

  async getAccessToken(backupAccountId: string, signal?: AbortSignal): Promise<string> {
    const cached = this.cache.get(backupAccountId);
    if (cached && cached.expiresAtMs - EXPIRY_SKEW_MS > Date.now()) {
      return cached.accessToken;
    }

    const account = this.accounts.findById(backupAccountId);
    if (!account) throw new BackupTokenRevokedError();

    let refreshToken: string;
    try {
      refreshToken = openFromString(
        account.encrypted_refresh_token,
        this.config.masterEncryptionKey,
        aad.backupRefreshToken(backupAccountId),
      );
    } catch {
      throw new Error("failed to decrypt backup account refresh token");
    }

    try {
      const oauthCreds = this.runtimeSettings.getGoogleOAuthCredentials();
      const res = await refreshAccessToken(oauthCreds, refreshToken, signal);
      const token: CachedToken = {
        accessToken: res.access_token,
        expiresAtMs: Date.now() + res.expires_in * 1000,
      };
      this.cache.set(backupAccountId, token);
      this.accounts.markRefreshed(backupAccountId);
      return token.accessToken;
    } catch (err) {
      const revoked = (err as Error & { revoked?: boolean }).revoked;
      this.accounts.markError(
        backupAccountId,
        revoked ? "reauthorization_required" : "error",
        revoked ? "token_revoked" : "refresh_failed",
      );
      this.cache.delete(backupAccountId);
      if (revoked) throw new BackupTokenRevokedError();
      throw err;
    }
  }

  invalidate(backupAccountId: string): void {
    this.cache.delete(backupAccountId);
  }
}
