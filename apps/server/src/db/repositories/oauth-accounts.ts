// OAuth accounts repository. Stores the encrypted refresh token per user.

import type { Database } from "bun:sqlite";
import { nowIso } from "../../util/ids.ts";

export interface OAuthAccountRow {
  user_id: string;
  encrypted_refresh_token: string;
  granted_scopes: string;
  token_version: number;
  last_refresh_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export class OAuthAccountsRepository {
  constructor(private readonly db: Database) {}

  find(userId: string): OAuthAccountRow | null {
    return (
      this.db
        .query<OAuthAccountRow, [string]>("SELECT * FROM oauth_accounts WHERE user_id = ?")
        .get(userId) ?? null
    );
  }

  /** Insert or replace the encrypted refresh token + granted scopes. */
  upsert(userId: string, encryptedRefreshToken: string, grantedScopes: string): void {
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO oauth_accounts
           (user_id, encrypted_refresh_token, granted_scopes, token_version, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           encrypted_refresh_token = excluded.encrypted_refresh_token,
           granted_scopes = excluded.granted_scopes,
           token_version = oauth_accounts.token_version + 1,
           last_error = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(userId, encryptedRefreshToken, grantedScopes, now, now);
  }

  updateScopes(userId: string, grantedScopes: string): void {
    this.db
      .query(
        "UPDATE oauth_accounts SET granted_scopes = ?, updated_at = ? WHERE user_id = ?",
      )
      .run(grantedScopes, nowIso(), userId);
  }

  markRefreshed(userId: string): void {
    const now = nowIso();
    this.db
      .query("UPDATE oauth_accounts SET last_refresh_at = ?, last_error = NULL, updated_at = ? WHERE user_id = ?")
      .run(now, now, userId);
  }

  markError(userId: string, error: string): void {
    const now = nowIso();
    this.db
      .query("UPDATE oauth_accounts SET last_error = ?, updated_at = ? WHERE user_id = ?")
      .run(error, now, userId);
  }

  delete(userId: string): void {
    this.db.query("DELETE FROM oauth_accounts WHERE user_id = ?").run(userId);
  }
}
