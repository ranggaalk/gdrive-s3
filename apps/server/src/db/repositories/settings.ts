// Runtime settings repository. Key-value overrides for boot-time env config
// (AGENTS.md-style: never stores plaintext secrets; callers encrypt first).

import type { Database } from "bun:sqlite";
import { nowIso } from "../../util/ids.ts";

export interface AppSettingRow {
  key: string;
  value: string;
  updated_by: string | null;
  updated_at: string;
}

export class SettingsRepository {
  constructor(private readonly db: Database) {}

  get(key: string): AppSettingRow | null {
    return (
      this.db.query<AppSettingRow, [string]>("SELECT * FROM app_settings WHERE key = ?").get(key) ?? null
    );
  }

  set(key: string, value: string, updatedBy: string | null): void {
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO app_settings (key, value, updated_by, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(key, value, updatedBy, now);
  }

  delete(key: string): void {
    this.db.query("DELETE FROM app_settings WHERE key = ?").run(key);
  }
}
