// Buckets repository. All queries scoped by user_id for ownership isolation.

import type { Database } from "bun:sqlite";
import { newBucketId, nowIso } from "../../util/ids.ts";

export type BucketStatus = "creating" | "active" | "deleting" | "error";
export type BucketEffectiveRole = "owner" | "editor" | "viewer";

export interface BucketRow {
  id: string;
  user_id: string;
  name: string;
  region: string;
  drive_folder_id: string;
  drive_target_id: string;
  status: BucketStatus;
  created_at: string;
  updated_at: string;
}

export interface AccessibleBucketRow extends BucketRow {
  effective_role: BucketEffectiveRole;
  storage_kind: "my_drive" | "shared_drive";
  storage_display_name: string;
  storage_status: string;
  shared_drive_id: string | null;
}

export class BucketsRepository {
  constructor(private readonly db: Database) {}

  listForUser(userId: string): BucketRow[] {
    return this.db
      .query<BucketRow, [string]>(
        "SELECT * FROM buckets WHERE user_id = ? ORDER BY name ASC",
      )
      .all(userId);
  }

  listAccessible(userId: string): AccessibleBucketRow[] {
    return this.db
      .query<AccessibleBucketRow, [string, string, string, string]>(
        `SELECT b.*,
                CASE WHEN b.user_id = ? THEN 'owner' ELSE m.role END AS effective_role,
                t.kind AS storage_kind,
                t.display_name AS storage_display_name,
                CASE WHEN b.user_id = ? THEN t.status ELSE m.access_status END AS storage_status,
                t.shared_drive_id
           FROM buckets b
           JOIN drive_targets t ON t.id = b.drive_target_id
      LEFT JOIN bucket_members m ON m.bucket_id = b.id AND m.user_id = ?
          WHERE (b.user_id = ? OR m.user_id IS NOT NULL)
            AND b.status = 'active'
          ORDER BY b.name ASC`,
      )
      .all(userId, userId, userId, userId);
  }

  findByName(userId: string, name: string): BucketRow | null {
    return (
      this.db
        .query<BucketRow, [string, string]>(
          "SELECT * FROM buckets WHERE user_id = ? AND name = ?",
        )
        .get(userId, name) ?? null
    );
  }

  findAccessibleByName(userId: string, name: string): AccessibleBucketRow | null {
    const rows = this.db
      .query<AccessibleBucketRow, [string, string, string, string, string]>(
        `SELECT b.*,
                CASE WHEN b.user_id = ? THEN 'owner' ELSE m.role END AS effective_role,
                t.kind AS storage_kind,
                t.display_name AS storage_display_name,
                CASE WHEN b.user_id = ? THEN t.status ELSE m.access_status END AS storage_status,
                t.shared_drive_id
           FROM buckets b
           JOIN drive_targets t ON t.id = b.drive_target_id
      LEFT JOIN bucket_members m ON m.bucket_id = b.id AND m.user_id = ?
          WHERE b.name = ? AND (b.user_id = ? OR m.user_id IS NOT NULL)
            AND b.status = 'active'
          LIMIT 2`,
      )
      .all(userId, userId, userId, name, userId);
    // Namespace conflicts are prevented when membership is granted. Refuse to
    // resolve rather than selecting an arbitrary bucket if older/corrupt data
    // violates that invariant.
    return rows.length === 1 ? rows[0]! : null;
  }

  findAccessibleById(userId: string, id: string): AccessibleBucketRow | null {
    return this.db
      .query<AccessibleBucketRow, [string, string, string, string, string]>(
        `SELECT b.*,
                CASE WHEN b.user_id = ? THEN 'owner' ELSE m.role END AS effective_role,
                t.kind AS storage_kind,
                t.display_name AS storage_display_name,
                CASE WHEN b.user_id = ? THEN t.status ELSE m.access_status END AS storage_status,
                t.shared_drive_id
           FROM buckets b
           JOIN drive_targets t ON t.id = b.drive_target_id
      LEFT JOIN bucket_members m ON m.bucket_id = b.id AND m.user_id = ?
          WHERE b.id = ? AND (b.user_id = ? OR m.user_id IS NOT NULL)
            AND b.status = 'active'
          LIMIT 1`,
      )
      .get(userId, userId, userId, id, userId) ?? null;
  }

  hasAccessibleName(userId: string, name: string, excludingBucketId?: string): boolean {
    const row = this.db
      .query<{ found: number }, [string, string, string, string]>(
        `SELECT 1 AS found
           FROM buckets b
      LEFT JOIN bucket_members m ON m.bucket_id = b.id AND m.user_id = ?
          WHERE b.name = ?
            AND (b.user_id = ? OR m.user_id IS NOT NULL)
            AND b.id != ?
            AND b.status IN ('creating', 'active')
          LIMIT 1`,
      )
      .get(userId, name, userId, excludingBucketId ?? "");
    return !!row;
  }

  findByIdOwned(userId: string, id: string): BucketRow | null {
    return (
      this.db
        .query<BucketRow, [string, string]>(
          "SELECT * FROM buckets WHERE id = ? AND user_id = ?",
        )
        .get(id, userId) ?? null
    );
  }

  create(
    userId: string,
    name: string,
    region: string,
    driveFolderId: string,
    driveTargetId?: string,
    status: BucketStatus = "active",
  ): BucketRow {
    const id = newBucketId();
    const now = nowIso();
    const targetId = driveTargetId ?? this.findMyDriveTargetId(userId);
    this.db
      .query(
        `INSERT INTO buckets
           (id, user_id, name, region, drive_folder_id, drive_target_id,
            status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, userId, name, region, driveFolderId, targetId, status, now, now);
    return this.findByIdOwned(userId, id)!;
  }

  private findMyDriveTargetId(userId: string): string {
    const target = this.db
      .query<{ id: string }, [string]>(
        "SELECT id FROM drive_targets WHERE owner_user_id = ? AND kind = 'my_drive'",
      )
      .get(userId);
    if (!target) throw new Error("My Drive target is not initialized");
    return target.id;
  }

  setDriveFolderId(userId: string, id: string, driveFolderId: string): void {
    this.db
      .query(
        `UPDATE buckets
            SET drive_folder_id = ?, status = 'active', updated_at = ?
          WHERE id = ? AND user_id = ?`,
      )
      .run(driveFolderId, nowIso(), id, userId);
  }

  setStatus(userId: string, id: string, status: BucketStatus): void {
    this.db
      .query("UPDATE buckets SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(status, nowIso(), id, userId);
  }

  delete(userId: string, id: string): void {
    this.db.query("DELETE FROM buckets WHERE id = ? AND user_id = ?").run(id, userId);
  }

  /** True when the bucket has an object or an unfinished multipart upload. */
  hasObjects(bucketId: string): boolean {
    const row = this.db
      .query<{ c: number }, [string, string]>(
        `SELECT
           (SELECT COUNT(*) FROM objects
             WHERE bucket_id = ? AND status != 'deleting') +
           (SELECT COUNT(*) FROM multipart_uploads
             WHERE bucket_id = ? AND status IN ('open', 'completing')) AS c`,
      )
      .get(bucketId, bucketId);
    return (row?.c ?? 0) > 0;
  }
}
