// TOTP secret + recovery code storage. Deliberately separate from
// UsersRepository: `totp_secrets` can hold an *unconfirmed* pending secret
// (during setup) without the account being 2FA-protected yet — only
// `confirm()` flips `users.totp_enabled`, the actual gate checked at login.

import type { Database } from "bun:sqlite";
import { newTotpRecoveryCodeId, nowIso } from "../../util/ids.ts";

export interface TotpSecretRow {
  user_id: string;
  encrypted_secret: string;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TotpRecoveryCodeRow {
  id: string;
  user_id: string;
  code_hash: string;
  used_at: string | null;
  created_at: string;
}

export class TotpRepository {
  constructor(private readonly db: Database) {}

  findSecret(userId: string): TotpSecretRow | null {
    return (
      this.db.query<TotpSecretRow, [string]>("SELECT * FROM totp_secrets WHERE user_id = ?").get(userId) ?? null
    );
  }

  /** (Re)start setup: stores an unconfirmed secret, replacing any prior pending one. */
  savePendingSecret(userId: string, encryptedSecret: string): void {
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO totp_secrets (user_id, encrypted_secret, confirmed_at, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           encrypted_secret = excluded.encrypted_secret,
           confirmed_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(userId, encryptedSecret, now, now);
  }

  /** Confirms setup (secret proven with a valid code) and enables 2FA for the account. */
  confirm(userId: string): void {
    const now = nowIso();
    const tx = this.db.transaction(() => {
      this.db
        .query("UPDATE totp_secrets SET confirmed_at = ?, updated_at = ? WHERE user_id = ?")
        .run(now, now, userId);
      this.db.query("UPDATE users SET totp_enabled = 1, updated_at = ? WHERE id = ?").run(now, userId);
    });
    tx();
  }

  /** Disables 2FA entirely: drops the secret and every recovery code. */
  disable(userId: string): void {
    const now = nowIso();
    const tx = this.db.transaction(() => {
      this.db.query("DELETE FROM totp_secrets WHERE user_id = ?").run(userId);
      this.db.query("DELETE FROM totp_recovery_codes WHERE user_id = ?").run(userId);
      this.db.query("UPDATE users SET totp_enabled = 0, updated_at = ? WHERE id = ?").run(now, userId);
    });
    tx();
  }

  /** Replaces the full recovery-code set (regeneration invalidates old ones). */
  replaceRecoveryCodes(userId: string, codeHashes: string[]): void {
    const now = nowIso();
    const tx = this.db.transaction(() => {
      this.db.query("DELETE FROM totp_recovery_codes WHERE user_id = ?").run(userId);
      for (const hash of codeHashes) {
        this.db
          .query(
            `INSERT INTO totp_recovery_codes (id, user_id, code_hash, used_at, created_at)
             VALUES (?, ?, ?, NULL, ?)`,
          )
          .run(newTotpRecoveryCodeId(), userId, hash, now);
      }
    });
    tx();
  }

  countUnusedRecoveryCodes(userId: string): number {
    return (
      this.db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM totp_recovery_codes WHERE user_id = ? AND used_at IS NULL",
        )
        .get(userId)?.n ?? 0
    );
  }

  findUnusedRecoveryCodeByHash(userId: string, codeHash: string): TotpRecoveryCodeRow | null {
    return (
      this.db
        .query<TotpRecoveryCodeRow, [string, string]>(
          "SELECT * FROM totp_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL",
        )
        .get(userId, codeHash) ?? null
    );
  }

  /** Atomically consumes a recovery code; returns false if it was already used (race-safe). */
  consumeRecoveryCode(id: string): boolean {
    return (
      this.db
        .query("UPDATE totp_recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL")
        .run(nowIso(), id).changes > 0
    );
  }
}
