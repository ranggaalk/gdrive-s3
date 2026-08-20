// Drive roots repository. Maps a user to their "DriveS3 Gateway" root folder id.

import type { Database } from "bun:sqlite";
import { nowIso } from "../../util/ids.ts";

export interface DriveRootRow {
  user_id: string;
  drive_folder_id: string;
  created_at: string;
  verified_at: string;
}

export class DriveRootsRepository {
  constructor(private readonly db: Database) {}

  find(userId: string): DriveRootRow | null {
    return (
      this.db
        .query<DriveRootRow, [string]>("SELECT * FROM drive_roots WHERE user_id = ?")
        .get(userId) ?? null
    );
  }

  upsert(userId: string, driveFolderId: string): void {
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO drive_roots (user_id, drive_folder_id, created_at, verified_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           drive_folder_id = excluded.drive_folder_id,
           verified_at = excluded.verified_at`,
      )
      .run(userId, driveFolderId, now, now);
  }
}
