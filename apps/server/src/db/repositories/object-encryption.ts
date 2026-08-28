// Per-object encryption metadata. A missing row means the object is stored in
// the clear, which is true of everything written before this feature existed.

import type { Database } from "bun:sqlite";
import { nowIso } from "../../util/ids.ts";

export type SseAlgorithm = "AES256" | "aws:kms";

export interface ObjectEncryptionRow {
  object_id: string;
  sse_algorithm: SseAlgorithm;
  kms_key_id: string | null;
  kms_key_version: number | null;
  wrapped_data_key: string | null;
  iv: string;
  customer_key_md5: string | null;
  created_at: string;
}

export class ObjectEncryptionRepository {
  constructor(private readonly db: Database) {}

  find(objectId: string): ObjectEncryptionRow | null {
    return (
      this.db
        .query<ObjectEncryptionRow, [string]>(
          "SELECT * FROM object_encryption WHERE object_id = ?",
        )
        .get(objectId) ?? null
    );
  }

  put(input: {
    objectId: string;
    algorithm: SseAlgorithm;
    kmsKeyId: string | null;
    kmsKeyVersion: number | null;
    wrappedDataKey: string | null;
    iv: string;
    customerKeyMd5: string | null;
  }): void {
    this.db
      .query(
        `INSERT INTO object_encryption
           (object_id, sse_algorithm, kms_key_id, kms_key_version,
            wrapped_data_key, iv, customer_key_md5, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(object_id) DO UPDATE SET
           sse_algorithm = excluded.sse_algorithm,
           kms_key_id = excluded.kms_key_id,
           kms_key_version = excluded.kms_key_version,
           wrapped_data_key = excluded.wrapped_data_key,
           iv = excluded.iv,
           customer_key_md5 = excluded.customer_key_md5`,
      )
      .run(
        input.objectId,
        input.algorithm,
        input.kmsKeyId,
        input.kmsKeyVersion,
        input.wrappedDataKey,
        input.iv,
        input.customerKeyMd5,
        nowIso(),
      );
  }

  /** Overwriting an object with an unencrypted body must clear any stale
   *  encryption metadata, or the next read would try to decrypt plaintext. */
  clear(objectId: string): void {
    this.db.query("DELETE FROM object_encryption WHERE object_id = ?").run(objectId);
  }
}
