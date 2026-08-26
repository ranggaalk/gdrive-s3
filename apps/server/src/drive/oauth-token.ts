// Access-token provider (AGENTS.md §7, §21). Decrypts the stored refresh token,
// exchanges it for a short-lived access token, caches it in memory (never in the
// DB or logs), and marks reconnect-required when the refresh token is revoked.

import type { AppConfig } from "../config.ts";
import { openFromString, aad } from "../security/encryption.ts";
import { refreshAccessToken } from "../auth/google-oauth.ts";
import { OAuthAccountsRepository } from "../db/repositories/oauth-accounts.ts";
import type { RuntimeSettingsService } from "../services/runtime-settings-service.ts";

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

export class TokenRevokedError extends Error {
  constructor() {
    super("google refresh token revoked");
    this.name = "TokenRevokedError";
  }
}

const EXPIRY_SKEW_MS = 60_000; // refresh a minute early

export class TokenProvider {
  private cache = new Map<string, CachedToken>();

  constructor(
    private readonly config: AppConfig,
    private readonly oauthRepo: OAuthAccountsRepository,
    private readonly runtimeSettings: RuntimeSettingsService,
  ) {}

  /** Return a valid access token for the user, refreshing if needed. */
  async getAccessToken(userId: string, signal?: AbortSignal): Promise<string> {
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAtMs - EXPIRY_SKEW_MS > Date.now()) {
      return cached.accessToken;
    }

    const account = this.oauthRepo.find(userId);
    if (!account) throw new TokenRevokedError();

    let refreshToken: string;
    try {
      refreshToken = openFromString(
        account.encrypted_refresh_token,
        this.config.masterEncryptionKey,
        aad.oauthRefreshToken(userId),
      );
    } catch {
      throw new Error("failed to decrypt refresh token");
    }

    try {
      const oauthCreds = this.runtimeSettings.getGoogleOAuthCredentials();
      const res = await refreshAccessToken(oauthCreds, refreshToken, signal);
      const token: CachedToken = {
        accessToken: res.access_token,
        expiresAtMs: Date.now() + res.expires_in * 1000,
      };
      this.cache.set(userId, token);
      this.oauthRepo.markRefreshed(userId);
      return token.accessToken;
    } catch (err) {
      const revoked = (err as Error & { revoked?: boolean }).revoked;
      this.oauthRepo.markError(userId, revoked ? "token_revoked" : "refresh_failed");
      this.cache.delete(userId);
      if (revoked) throw new TokenRevokedError();
      throw err;
    }
  }

  invalidate(userId: string): void {
    this.cache.delete(userId);
  }
}
