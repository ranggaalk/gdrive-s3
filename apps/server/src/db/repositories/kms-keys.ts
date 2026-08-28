// Customer master keys and their superseded versions.
//
// Rotation is append-only: the current material moves into kms_key_versions
// before the new material replaces it, so objects written under an older
// version stay readable.

import type { Database } from "bun:sqlite";
import { nowIso } from "../../util/ids.ts";

export type KmsKeyStatus = "active" | "disabled";

export interface KmsKeyRow {
  id: string;
  user_id: string;
  alias: string;
  encrypted_material: string;
  version: number;
  status: KmsKeyStatus;
  rotated_at: string | null;
  created_at: string;
  updated_at: string;
}

export class KmsAliasConflictError extends Error {
  constructor() {
    super("A key with that alias already exists");
    this.name = "KmsAliasConflictError";
  }
}

export class KmsKeysRepository {
  constructor(private readonly db: Database) {}

  nextId(): string {
    return `kms_${crypto.randomUUID().replace(/-/g, "")}`;
  }

  listForUser(userId: string): KmsKeyRow[] {
    return this.db
      .query<KmsKeyRow, [string]>(
        "SELECT * FROM kms_keys WHERE user_id = ? ORDER BY created_at DESC",
      )
      .all(userId);
  }

  findById(id: string): KmsKeyRow | null {
    return (
      this.db.query<KmsKeyRow, [string]>("SELECT * FROM kms_keys WHERE id = ?").get(id) ?? null
    );
  }

  findOwned(userId: string, id: string): KmsKeyRow | null {
    return (
      this.db
        .query<KmsKeyRow, [string, string]>(
          "SELECT * FROM kms_keys WHERE id = ? AND user_id = ?",
        )
        .get(id, userId) ?? null
    );
  }

  /** Resolve an alias to a key, so requests can name `alias/my-key` as S3 does. */
  findByAlias(userId: string, alias: string): KmsKeyRow | null {
    return (
      this.db
        .query<KmsKeyRow, [string, string]>(
          "SELECT * FROM kms_keys WHERE user_id = ? AND alias = ?",
        )
        .get(userId, alias) ?? null
    );
  }

  create(input: {
    id: string;
    userId: string;
    alias: string;
    encryptedMaterial: string;
  }): KmsKeyRow {
    const now = nowIso();
    try {
      this.db
        .query(
          `INSERT INTO kms_keys
             (id, user_id, alias, encrypted_material, version, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, 'active', ?, ?)`,
        )
        .run(input.id, input.userId, input.alias, input.encryptedMaterial, now, now);
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new KmsAliasConflictError();
      throw error;
    }
    return this.findById(input.id)!;
  }

  /** Archive the current material and install new material, in one transaction
   *  so a crash cannot lose the old key while the new one is live. */
  rotate(input: { id: string; encryptedMaterial: string }): KmsKeyRow {
    const tx = this.db.transaction(() => {
      const current = this.findById(input.id);
      if (!current) throw new Error("kms key disappeared during rotation");
      const now = nowIso();
      this.db
        .query(
          `INSERT INTO kms_key_versions (kms_key_id, version, encrypted_material, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(kms_key_id, version) DO NOTHING`,
        )
        .run(current.id, current.version, current.encrypted_material, now);
      this.db
        .query(
          `UPDATE kms_keys
              SET encrypted_material = ?, version = version + 1,
                  rotated_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(input.encryptedMaterial, now, now, input.id);
    });
    tx();
    return this.findById(input.id)!;
  }

  findVersionMaterial(kmsKeyId: string, version: number): string | null {
    const row = this.db
      .query<{ encrypted_material: string }, [string, number]>(
        "SELECT encrypted_material FROM kms_key_versions WHERE kms_key_id = ? AND version = ?",
      )
      .get(kmsKeyId, version);
    return row?.encrypted_material ?? null;
  }

  setStatus(id: string, status: KmsKeyStatus): KmsKeyRow {
    this.db
      .query("UPDATE kms_keys SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, nowIso(), id);
    return this.findById(id)!;
  }

  /** How many objects still reference this key. A key with live objects must
   *  not be deleted, which the FK also enforces. */
  objectCount(kmsKeyId: string): number {
    const row = this.db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) AS c FROM object_encryption WHERE kms_key_id = ?",
      )
      .get(kmsKeyId);
    return row?.c ?? 0;
  }
}
