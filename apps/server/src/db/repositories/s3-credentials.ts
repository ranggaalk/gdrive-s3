// S3 credentials repository (AGENTS.md §9, §10). The access key id is stored
// plaintext; the secret is stored only as an encrypted envelope. Ownership is
// enforced on every scoped query.

import type { Database } from "bun:sqlite";
import { nowIso } from "../../util/ids.ts";

export type CredentialStatus = "active" | "revoked";

export interface CredentialRow {
  id: string;
  user_id: string;
  access_key_id: string;
  encrypted_secret_key: string;
  label: string;
  status: CredentialStatus;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export class S3CredentialsRepository {
  constructor(private readonly db: Database) {}

  create(input: {
    id: string;
    userId: string;
    accessKeyId: string;
    encryptedSecretKey: string;
    label: string;
  }): CredentialRow {
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO s3_credentials
           (id, user_id, access_key_id, encrypted_secret_key, label, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(input.id, input.userId, input.accessKeyId, input.encryptedSecretKey, input.label, now);
    return this.findByIdOwned(input.userId, input.id)!;
  }

  listForUser(userId: string): CredentialRow[] {
    return this.db
      .query<CredentialRow, [string]>(
        "SELECT * FROM s3_credentials WHERE user_id = ? ORDER BY created_at DESC",
      )
      .all(userId);
  }

  findByIdOwned(userId: string, id: string): CredentialRow | null {
    return (
      this.db
        .query<CredentialRow, [string, string]>(
          "SELECT * FROM s3_credentials WHERE id = ? AND user_id = ?",
        )
        .get(id, userId) ?? null
    );
  }

  /** Used by the SigV4 verifier (Milestone 4): look up an active key globally. */
  findActiveByAccessKeyId(accessKeyId: string): CredentialRow | null {
    return (
      this.db
        .query<CredentialRow, [string]>(
          `SELECT c.* FROM s3_credentials c
             JOIN users u ON u.id = c.user_id
            WHERE c.access_key_id = ? AND c.status = 'active' AND u.status = 'active'`,
        )
        .get(accessKeyId) ?? null
    );
  }

  revoke(userId: string, id: string): boolean {
    const changes = this.db
      .query(
        "UPDATE s3_credentials SET status = 'revoked', revoked_at = ? WHERE id = ? AND user_id = ? AND status = 'active'",
      )
      .run(nowIso(), id, userId).changes;
    return changes > 0;
  }

  deleteRevoked(userId: string, id: string): boolean {
    const changes = this.db
      .query(
        "DELETE FROM s3_credentials WHERE id = ? AND user_id = ? AND status = 'revoked'",
      )
      .run(id, userId).changes;
    return changes > 0;
  }

  markUsed(id: string): void {
    this.db.query("UPDATE s3_credentials SET last_used_at = ? WHERE id = ?").run(nowIso(), id);
  }
}
