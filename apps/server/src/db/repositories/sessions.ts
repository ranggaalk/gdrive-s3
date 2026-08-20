// Sessions repository. Only the SHA-256 hash of the session id is stored,
// never the raw id (AGENTS.md §7, §9).

import type { Database } from "bun:sqlite";
import { nowIso } from "../../util/ids.ts";

export interface SessionRow {
  id_hash: string;
  user_id: string;
  csrf_secret: string;
  expires_at: string;
  created_at: string;
  last_seen_at: string;
  user_agent: string | null;
  ip_hash: string | null;
}

export interface CreateSessionInput {
  idHash: string;
  userId: string;
  csrfSecret: string;
  expiresAt: string;
  userAgent: string | null;
  ipHash: string | null;
}

export class SessionsRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateSessionInput): void {
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO sessions
           (id_hash, user_id, csrf_secret, expires_at, created_at, last_seen_at, user_agent, ip_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.idHash,
        input.userId,
        input.csrfSecret,
        input.expiresAt,
        now,
        now,
        input.userAgent,
        input.ipHash,
      );
  }

  findValid(idHash: string, nowIsoStr = nowIso()): SessionRow | null {
    return (
      this.db
        .query<SessionRow, [string, string]>(
          "SELECT * FROM sessions WHERE id_hash = ? AND expires_at > ?",
        )
        .get(idHash, nowIsoStr) ?? null
    );
  }

  touch(idHash: string): void {
    this.db.query("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").run(nowIso(), idHash);
  }

  delete(idHash: string): void {
    this.db.query("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
  }

  deleteAllForUser(userId: string): void {
    this.db.query("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  deleteExpired(nowIsoStr = nowIso()): number {
    return this.db.query("DELETE FROM sessions WHERE expires_at <= ?").run(nowIsoStr).changes;
  }
}
