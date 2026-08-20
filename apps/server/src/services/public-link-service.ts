import { createHash, randomBytes } from "node:crypto";
import type { AppConfig } from "../config.ts";
import type {
  PublicObjectLinkRow,
  PublicObjectLinksRepository,
  ResolvedPublicObjectLink,
} from "../db/repositories/public-object-links.ts";
import { newPublicLinkId } from "../util/ids.ts";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_TOKEN_ATTEMPTS = 3;

export interface PublicLinkSummary {
  id: string;
  label: string;
  status: "active" | "revoked";
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastAccessedAt: string | null;
}

export class PublicLinkService {
  constructor(
    private readonly repo: PublicObjectLinksRepository,
    private readonly config: AppConfig,
  ) {}

  create(input: {
    ownerUserId: string;
    objectId: string;
    label: string;
    expiresAt: string | null;
  }): PublicLinkSummary & { url: string } {
    const label = input.label.trim();
    if (!label || label.length > 100) throw new TypeError("invalid public link label");
    const expiresAt = normalizeExpiry(input.expiresAt);
    for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt++) {
      const token = randomBytes(32).toString("base64url");
      try {
        const row = this.repo.create({
          id: newPublicLinkId(),
          objectId: input.objectId,
          ownerUserId: input.ownerUserId,
          tokenHash: tokenHash(token),
          label,
          expiresAt,
        });
        return {
          ...summary(row),
          url: `${this.config.s3PublicEndpoint}/__drives3_share/${token}`,
        };
      } catch (error) {
        if (attempt === MAX_TOKEN_ATTEMPTS - 1 || !isTokenCollision(error)) throw error;
      }
    }
    throw new Error("public link token generation exhausted");
  }

  list(ownerUserId: string, objectId: string): PublicLinkSummary[] {
    return this.repo.listForObject(ownerUserId, objectId).map(summary);
  }

  revoke(ownerUserId: string, objectId: string, linkId: string): boolean {
    const existing = this.repo.findManaged(ownerUserId, objectId, linkId);
    if (!existing) return false;
    if (existing.status === "active") this.repo.revoke(ownerUserId, objectId, linkId);
    return true;
  }

  resolve(token: string): ResolvedPublicObjectLink | null {
    if (!TOKEN_PATTERN.test(token)) return null;
    return this.repo.resolveActive(tokenHash(token));
  }
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function summary(row: PublicObjectLinkRow): PublicLinkSummary {
  return {
    id: row.id,
    label: row.label,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastAccessedAt: row.last_accessed_at,
  };
}

function isTokenCollision(error: unknown): boolean {
  return error instanceof Error &&
    /UNIQUE constraint failed: public_object_links\.token_hash/i.test(error.message);
}

function normalizeExpiry(value: string | null): string | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw new TypeError("invalid public link expiry");
  }
  return new Date(timestamp).toISOString();
}
