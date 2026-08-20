import type { Database } from "bun:sqlite";
import { nowIso } from "../../util/ids.ts";

export type BucketMemberRole = "viewer" | "editor";
export type BucketMemberAccessStatus =
  | "active"
  | "inaccessible"
  | "reauthorization_required";

export interface BucketMemberRow {
  bucket_id: string;
  user_id: string;
  role: BucketMemberRole;
  access_status: BucketMemberAccessStatus;
  created_by: string;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BucketMemberView extends BucketMemberRow {
  email: string;
  display_name: string | null;
}

export class BucketMembersRepository {
  constructor(private readonly db: Database) {}

  find(bucketId: string, userId: string): BucketMemberRow | null {
    return this.db
      .query<BucketMemberRow, [string, string]>(
        "SELECT * FROM bucket_members WHERE bucket_id = ? AND user_id = ?",
      )
      .get(bucketId, userId) ?? null;
  }

  list(bucketId: string): BucketMemberView[] {
    return this.db
      .query<BucketMemberView, [string]>(
        `SELECT m.*, u.email, u.display_name
           FROM bucket_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.bucket_id = ?
          ORDER BY u.email ASC`,
      )
      .all(bucketId);
  }

  add(input: {
    bucketId: string;
    userId: string;
    role: BucketMemberRole;
    createdBy: string;
  }): BucketMemberRow {
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO bucket_members
           (bucket_id, user_id, role, access_status, created_by,
            verified_at, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
         ON CONFLICT(bucket_id, user_id) DO UPDATE SET
           role = excluded.role,
           access_status = 'active',
           verified_at = excluded.verified_at,
           updated_at = excluded.updated_at`,
      )
      .run(input.bucketId, input.userId, input.role, input.createdBy, now, now, now);
    return this.find(input.bucketId, input.userId)!;
  }

  setRole(bucketId: string, userId: string, role: BucketMemberRole): boolean {
    return this.db
      .query(
        `UPDATE bucket_members SET role = ?, updated_at = ?
          WHERE bucket_id = ? AND user_id = ?`,
      )
      .run(role, nowIso(), bucketId, userId).changes > 0;
  }

  markAccess(
    bucketId: string,
    userId: string,
    status: BucketMemberAccessStatus,
  ): boolean {
    const now = nowIso();
    return this.db
      .query(
        `UPDATE bucket_members
            SET access_status = ?, verified_at = ?, updated_at = ?
          WHERE bucket_id = ? AND user_id = ?`,
      )
      .run(status, now, now, bucketId, userId).changes > 0;
  }

  remove(bucketId: string, userId: string): boolean {
    return this.db
      .query("DELETE FROM bucket_members WHERE bucket_id = ? AND user_id = ?")
      .run(bucketId, userId).changes > 0;
  }
}
