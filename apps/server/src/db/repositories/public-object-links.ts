import type { Database } from "bun:sqlite";
import { nowIso } from "../../util/ids.ts";

export interface PublicObjectLinkRow {
  id: string;
  object_id: string;
  owner_user_id: string;
  token_hash: string;
  label: string;
  status: "active" | "revoked";
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
  last_accessed_at: string | null;
}

export interface ResolvedPublicObjectLink extends PublicObjectLinkRow {
  object_key: string;
  bucket_id: string;
  bucket_name: string;
  drive_file_id: string;
  size_bytes: number;
  content_type: string;
  etag: string;
  metadata_json: string;
  cache_control: string | null;
  content_disposition: string | null;
  content_encoding: string | null;
  content_language: string | null;
  object_expires_at: string | null;
  last_modified_at: string;
  object_created_at: string;
  object_updated_at: string;
  bucket_owner_id: string;
  bucket_region: string;
  drive_folder_id: string;
  drive_target_id: string;
  bucket_status: string;
  storage_kind: "my_drive" | "shared_drive";
  storage_display_name: string;
  storage_status: string;
  shared_drive_id: string | null;
}

export class PublicObjectLinksRepository {
  constructor(private readonly db: Database) {}

  create(input: {
    id: string;
    objectId: string;
    ownerUserId: string;
    tokenHash: string;
    label: string;
    expiresAt: string | null;
  }): PublicObjectLinkRow {
    const now = nowIso();
    this.db.query(
      `INSERT INTO public_object_links
         (id, object_id, owner_user_id, token_hash, label, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      input.id,
      input.objectId,
      input.ownerUserId,
      input.tokenHash,
      input.label,
      input.expiresAt,
      now,
    );
    return this.findManaged(input.ownerUserId, input.objectId, input.id)!;
  }

  listForObject(ownerUserId: string, objectId: string): PublicObjectLinkRow[] {
    return this.db.query<PublicObjectLinkRow, [string, string]>(
      `SELECT * FROM public_object_links
        WHERE owner_user_id = ? AND object_id = ?
        ORDER BY created_at DESC`,
    ).all(ownerUserId, objectId);
  }

  findManaged(ownerUserId: string, objectId: string, id: string): PublicObjectLinkRow | null {
    return this.db.query<PublicObjectLinkRow, [string, string, string]>(
      `SELECT * FROM public_object_links
        WHERE owner_user_id = ? AND object_id = ? AND id = ?`,
    ).get(ownerUserId, objectId, id) ?? null;
  }

  revoke(ownerUserId: string, objectId: string, id: string): boolean {
    const changes = this.db.query(
      `UPDATE public_object_links
          SET status = 'revoked', revoked_at = ?
        WHERE owner_user_id = ? AND object_id = ? AND id = ? AND status = 'active'`,
    ).run(nowIso(), ownerUserId, objectId, id).changes;
    return changes > 0;
  }

  resolveActive(tokenHash: string, now = nowIso()): ResolvedPublicObjectLink | null {
    return this.db.query<ResolvedPublicObjectLink, [string, string]>(
      `SELECT l.*,
              o.object_key, o.bucket_id, o.drive_file_id, o.size_bytes,
              o.content_type, o.etag, o.metadata_json, o.cache_control,
              o.content_disposition, o.content_encoding, o.content_language,
              o.expires_at AS object_expires_at, o.last_modified_at,
              o.created_at AS object_created_at, o.updated_at AS object_updated_at,
              b.name AS bucket_name, b.user_id AS bucket_owner_id,
              b.region AS bucket_region, b.drive_folder_id, b.drive_target_id,
              b.status AS bucket_status,
              t.kind AS storage_kind, t.display_name AS storage_display_name,
              t.status AS storage_status, t.shared_drive_id
         FROM public_object_links l
         JOIN objects o ON o.id = l.object_id AND o.status = 'active'
         JOIN buckets b ON b.id = o.bucket_id AND b.status = 'active'
         JOIN users u ON u.id = l.owner_user_id AND u.status = 'active'
         JOIN drive_targets t ON t.id = b.drive_target_id AND t.status = 'active'
        WHERE l.token_hash = ?
          AND l.status = 'active'
          AND (l.expires_at IS NULL OR l.expires_at > ?)
          AND l.owner_user_id = b.user_id
          AND u.id = b.user_id
        LIMIT 1`,
    ).get(tokenHash, now) ?? null;
  }

  markAccessed(id: string): void {
    this.db.query(
      "UPDATE public_object_links SET last_accessed_at = ? WHERE id = ?",
    ).run(nowIso(), id);
  }
}
