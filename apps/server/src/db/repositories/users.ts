// Users repository. Prepared statements only (AGENTS.md §25).

import type { Database } from "bun:sqlite";
import { newUserId, nowIso } from "../../util/ids.ts";

export interface UserRow {
  id: string;
  google_sub: string;
  email: string;
  display_name: string | null;
  hosted_domain: string;
  status: "active" | "revoked" | "disabled";
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface UpsertUserInput {
  googleSub: string;
  email: string;
  displayName: string | null;
  hostedDomain: string;
}

export class UsersRepository {
  constructor(private readonly db: Database) {}

  findByGoogleSub(googleSub: string): UserRow | null {
    return (
      this.db
        .query<UserRow, [string]>("SELECT * FROM users WHERE google_sub = ?")
        .get(googleSub) ?? null
    );
  }

  findById(id: string): UserRow | null {
    return this.db.query<UserRow, [string]>("SELECT * FROM users WHERE id = ?").get(id) ?? null;
  }

  findActiveByEmail(email: string, hostedDomain: string): UserRow | null {
    return this.db
      .query<UserRow, [string, string]>(
        `SELECT * FROM users
          WHERE lower(email) = lower(?) AND hosted_domain = ? AND status = 'active'`,
      )
      .get(email, hostedDomain) ?? null;
  }

  /** Create the user if new, otherwise refresh profile fields + last_login. */
  upsertOnLogin(input: UpsertUserInput): UserRow {
    const existing = this.findByGoogleSub(input.googleSub);
    const now = nowIso();
    if (existing) {
      this.db
        .query(
          `UPDATE users
             SET email = ?, display_name = ?, hosted_domain = ?,
                 updated_at = ?, last_login_at = ?
           WHERE id = ?`,
        )
        .run(input.email, input.displayName, input.hostedDomain, now, now, existing.id);
      return this.findById(existing.id)!;
    }
    const id = newUserId();
    this.db
      .query(
        `INSERT INTO users
           (id, google_sub, email, display_name, hosted_domain, status,
            created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(id, input.googleSub, input.email, input.displayName, input.hostedDomain, now, now, now);
    return this.findById(id)!;
  }
}
