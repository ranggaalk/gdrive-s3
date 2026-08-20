// S3 credential lifecycle. Secrets are generated server-side, returned exactly
// once, and persisted only as purpose-bound encrypted envelopes.

import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config.ts";
import type { AuditLogsRepository } from "../db/repositories/audit-logs.ts";
import {
  S3CredentialsRepository,
  type CredentialRow,
} from "../db/repositories/s3-credentials.ts";
import { aad, sealToString } from "../security/encryption.ts";
import { newCredentialId } from "../util/ids.ts";

const MAX_CREATE_ATTEMPTS = 3;

function generateAccessKeyId(): string {
  const raw = randomBytes(16).toString("base64").replace(/[^A-Z0-9]/gi, "").toUpperCase();
  return ("AKIA" + raw).slice(0, 20).padEnd(20, "0");
}

function generateSecretKey(): string {
  return randomBytes(30).toString("base64").replace(/[+/=]/g, "").slice(0, 40).padEnd(40, "a");
}

export interface CreatedCredential {
  id: string;
  accessKeyId: string;
  secretAccessKey: string;
  label: string;
  createdAt: string;
}

export interface CredentialSummary {
  id: string;
  access_key_id: string;
  label: string;
  status: "active" | "revoked";
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export class CredentialNotFoundError extends Error {}
export class CredentialStateError extends Error {}

export class CredentialService {
  constructor(
    private readonly repo: S3CredentialsRepository,
    private readonly config: AppConfig,
    private readonly db?: Database,
    private readonly audit?: AuditLogsRepository,
  ) {}

  create(userId: string, label: string): CreatedCredential {
    const normalizedLabel = label.trim() || "default";
    if (normalizedLabel.length > 100) throw new TypeError("invalid credential label");
    return this.createNormalized(userId, normalizedLabel);
  }

  private createNormalized(userId: string, label: string): CreatedCredential {
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
      const id = newCredentialId();
      const accessKeyId = generateAccessKeyId();
      const secretAccessKey = generateSecretKey();
      const encrypted = sealToString(
        secretAccessKey,
        this.config.masterEncryptionKey,
        aad.s3Secret(id),
      );
      try {
        const row = this.repo.create({
          id,
          userId,
          accessKeyId,
          encryptedSecretKey: encrypted,
          label,
        });
        return createdView(row, secretAccessKey);
      } catch (error) {
        if (attempt === MAX_CREATE_ATTEMPTS - 1 || !isUniqueConstraint(error)) throw error;
      }
    }
    throw new Error("credential generation exhausted");
  }

  createAudited(userId: string, label: string, requestId: string): CreatedCredential {
    return this.transaction(() => {
      const created = this.createNormalized(userId, normalizeLabel(label));
      this.audit!.record({
        userId,
        credentialId: created.id,
        action: "credential.create",
        statusCode: 201,
        requestId,
        detail: { credentialId: created.id, label: created.label },
      });
      return created;
    });
  }

  list(userId: string): CredentialSummary[] {
    return this.repo.listForUser(userId).map(summaryView);
  }

  rotateActive(userId: string, id: string, requestId: string): CreatedCredential {
    return this.transaction(() => {
      const old = this.repo.findByIdOwned(userId, id);
      if (!old) throw new CredentialNotFoundError();
      if (old.status !== "active") throw new CredentialStateError();
      const created = this.createNormalized(userId, old.label);
      if (!this.repo.revoke(userId, old.id)) throw new CredentialStateError();
      this.audit!.record({
        userId,
        credentialId: created.id,
        action: "credential.rotate",
        statusCode: 201,
        requestId,
        detail: {
          oldCredentialId: old.id,
          oldAccessKeyId: old.access_key_id,
          newCredentialId: created.id,
          newAccessKeyId: created.accessKeyId,
          label: old.label,
        },
      });
      return created;
    });
  }

  /** Internal/compat helper. Control-plane revocation uses revokeActive(). */
  revoke(userId: string, id: string): boolean {
    return this.repo.revoke(userId, id);
  }

  revokeActive(userId: string, id: string, requestId: string): void {
    this.transaction(() => {
      const row = this.repo.findByIdOwned(userId, id);
      if (!row) throw new CredentialNotFoundError();
      if (row.status !== "active") throw new CredentialStateError();
      if (!this.repo.revoke(userId, id)) throw new CredentialStateError();
      this.audit!.record({
        userId,
        credentialId: id,
        action: "credential.revoke",
        statusCode: 200,
        requestId,
        detail: { credentialId: id, accessKeyId: row.access_key_id, label: row.label },
      });
    });
  }

  deleteRevoked(userId: string, id: string, requestId: string): void {
    this.transaction(() => {
      const row = this.repo.findByIdOwned(userId, id);
      if (!row) throw new CredentialNotFoundError();
      if (row.status !== "revoked") throw new CredentialStateError();
      this.audit!.record({
        userId,
        credentialId: null,
        action: "credential.delete",
        statusCode: 200,
        requestId,
        detail: {
          credentialId: id,
          accessKeyId: row.access_key_id,
          label: row.label,
          createdAt: row.created_at,
          revokedAt: row.revoked_at,
        },
      });
      if (!this.repo.deleteRevoked(userId, id)) throw new CredentialStateError();
    });
  }

  private transaction<T>(operation: () => T): T {
    if (!this.db || !this.audit) {
      throw new Error("credential lifecycle dependencies are not configured");
    }
    return this.db.transaction(operation)();
  }
}

export function normalizeLabel(value: string): string {
  const label = value.trim();
  if (!label || label.length > 100) throw new TypeError("invalid credential label");
  return label;
}

function summaryView(row: CredentialRow): CredentialSummary {
  return {
    id: row.id,
    access_key_id: row.access_key_id,
    label: row.label,
    status: row.status,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  };
}

function createdView(row: CredentialRow, secretAccessKey: string): CreatedCredential {
  return {
    id: row.id,
    accessKeyId: row.access_key_id,
    secretAccessKey,
    label: row.label,
    createdAt: row.created_at,
  };
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: s3_credentials\.access_key_id/i.test(error.message);
}
