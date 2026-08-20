import type { Database } from "bun:sqlite";
import { newDriveTargetId, nowIso } from "../../util/ids.ts";

export type DriveTargetKind = "my_drive" | "shared_drive";
export type DriveTargetStatus =
  | "active"
  | "reauthorization_required"
  | "inaccessible"
  | "read_only"
  | "error";

export interface DriveTargetRow {
  id: string;
  owner_user_id: string;
  kind: DriveTargetKind;
  shared_drive_id: string | null;
  root_folder_id: string | null;
  display_name: string;
  status: DriveTargetStatus;
  last_error: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export class DriveTargetsRepository {
  constructor(private readonly db: Database) {}

  findById(id: string): DriveTargetRow | null {
    return this.db.query<DriveTargetRow, [string]>("SELECT * FROM drive_targets WHERE id = ?").get(id) ?? null;
  }

  findOwned(ownerUserId: string, id: string): DriveTargetRow | null {
    return this.db
      .query<DriveTargetRow, [string, string]>(
        "SELECT * FROM drive_targets WHERE id = ? AND owner_user_id = ?",
      )
      .get(id, ownerUserId) ?? null;
  }

  findMyDrive(ownerUserId: string): DriveTargetRow | null {
    return this.db
      .query<DriveTargetRow, [string]>(
        "SELECT * FROM drive_targets WHERE owner_user_id = ? AND kind = 'my_drive'",
      )
      .get(ownerUserId) ?? null;
  }

  findSharedDrive(ownerUserId: string, sharedDriveId: string): DriveTargetRow | null {
    return this.db
      .query<DriveTargetRow, [string, string]>(
        `SELECT * FROM drive_targets
          WHERE owner_user_id = ? AND kind = 'shared_drive' AND shared_drive_id = ?`,
      )
      .get(ownerUserId, sharedDriveId) ?? null;
  }

  ensureMyDrive(ownerUserId: string, rootFolderId: string | null = null): DriveTargetRow {
    const existing = this.findMyDrive(ownerUserId);
    if (existing) return existing;
    const now = nowIso();
    const id = newDriveTargetId();
    this.db
      .query(
        `INSERT INTO drive_targets
           (id, owner_user_id, kind, shared_drive_id, root_folder_id, display_name,
            status, verified_at, created_at, updated_at)
         VALUES (?, ?, 'my_drive', NULL, ?, 'My Drive', 'active', ?, ?, ?)`,
      )
      .run(id, ownerUserId, rootFolderId, rootFolderId ? now : null, now, now);
    return this.findById(id)!;
  }

  createSharedDrive(input: {
    ownerUserId: string;
    sharedDriveId: string;
    displayName: string;
    rootFolderId?: string | null;
  }): DriveTargetRow {
    const existing = this.findSharedDrive(input.ownerUserId, input.sharedDriveId);
    if (existing) {
      const now = nowIso();
      this.db
        .query(
          `UPDATE drive_targets
              SET display_name = ?, status = 'active', last_error = NULL,
                  verified_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(input.displayName, now, now, existing.id);
      return this.findById(existing.id)!;
    }
    const id = newDriveTargetId();
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO drive_targets
           (id, owner_user_id, kind, shared_drive_id, root_folder_id, display_name,
            status, verified_at, created_at, updated_at)
         VALUES (?, ?, 'shared_drive', ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        id,
        input.ownerUserId,
        input.sharedDriveId,
        input.rootFolderId ?? null,
        input.displayName,
        now,
        now,
        now,
      );
    return this.findById(id)!;
  }

  setRoot(id: string, rootFolderId: string): void {
    const now = nowIso();
    this.db
      .query(
        `UPDATE drive_targets
            SET root_folder_id = ?, status = 'active', last_error = NULL,
                verified_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(rootFolderId, now, now, id);
  }

  markStatus(id: string, status: DriveTargetStatus, error: string | null): void {
    const now = nowIso();
    this.db
      .query(
        `UPDATE drive_targets
            SET status = ?, last_error = ?, verified_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(status, error, now, now, id);
  }
}
