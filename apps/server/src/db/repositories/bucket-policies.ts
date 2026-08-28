// Bucket policy documents. One row per bucket: PutBucketPolicy replaces the
// whole document rather than merging statements, mirroring S3.

import type { Database } from "bun:sqlite";
import { nowIso } from "../../util/ids.ts";

export interface BucketPolicyRow {
  bucket_id: string;
  policy_json: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export class BucketPoliciesRepository {
  constructor(private readonly db: Database) {}

  find(bucketId: string): BucketPolicyRow | null {
    return (
      this.db
        .query<BucketPolicyRow, [string]>("SELECT * FROM bucket_policies WHERE bucket_id = ?")
        .get(bucketId) ?? null
    );
  }

  put(input: { bucketId: string; policyJson: string; updatedBy: string }): BucketPolicyRow {
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO bucket_policies (bucket_id, policy_json, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(bucket_id) DO UPDATE SET
           policy_json = excluded.policy_json,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(input.bucketId, input.policyJson, input.updatedBy, now, now);
    return this.find(input.bucketId)!;
  }

  delete(bucketId: string): boolean {
    return this.db.query("DELETE FROM bucket_policies WHERE bucket_id = ?").run(bucketId)
      .changes > 0;
  }
}
