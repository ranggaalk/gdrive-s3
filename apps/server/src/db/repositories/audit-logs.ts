// Audit log repository (AGENTS.md §19, §23). Append-only record of
// control-plane and data-plane actions, scoped by user for the dashboard.

import type { Database } from "bun:sqlite";
import { newAuditId, nowIso } from "../../util/ids.ts";

export interface AuditLogRow {
  id: string;
  user_id: string | null;
  credential_id: string | null;
  action: string;
  bucket_name: string | null;
  object_key: string | null;
  status_code: number | null;
  request_id: string;
  bytes_in: number | null;
  bytes_out: number | null;
  ip_hash: string | null;
  user_agent: string | null;
  detail_json: string;
  created_at: string;
}

export interface AuditEntry {
  userId: string | null;
  credentialId?: string | null;
  action: string;
  bucketName?: string | null;
  objectKey?: string | null;
  statusCode?: number | null;
  requestId: string;
  bytesIn?: number | null;
  bytesOut?: number | null;
  ipHash?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown>;
}

export class AuditLogsRepository {
  constructor(private readonly db: Database) {}

  record(entry: AuditEntry): void {
    this.db
      .query(
        `INSERT INTO audit_logs
           (id, user_id, credential_id, action, bucket_name, object_key,
            status_code, request_id, bytes_in, bytes_out, ip_hash, user_agent,
            detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newAuditId(),
        entry.userId,
        entry.credentialId ?? null,
        entry.action,
        entry.bucketName ?? null,
        entry.objectKey ?? null,
        entry.statusCode ?? null,
        entry.requestId,
        entry.bytesIn ?? null,
        entry.bytesOut ?? null,
        entry.ipHash ?? null,
        entry.userAgent ?? null,
        JSON.stringify(entry.detail ?? {}),
        nowIso(),
      );
  }

  listForUser(userId: string, opts: { limit: number; before?: string }): AuditLogRow[] {
    const before = opts.before ?? "9999-12-31T23:59:59.999Z";
    return this.db
      .query<AuditLogRow, [string, string, number]>(
        `SELECT * FROM audit_logs
          WHERE user_id = ? AND created_at < ?
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(userId, before, opts.limit);
  }
}
