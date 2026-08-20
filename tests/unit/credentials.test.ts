import { describe, expect, test } from "bun:test";
import { openMemoryDatabase } from "../../apps/server/src/db/connection.ts";
import { runMigrations } from "../../apps/server/src/db/migrate.ts";
import { UsersRepository } from "../../apps/server/src/db/repositories/users.ts";
import { S3CredentialsRepository } from "../../apps/server/src/db/repositories/s3-credentials.ts";
import { AuditLogsRepository } from "../../apps/server/src/db/repositories/audit-logs.ts";
import { CredentialService } from "../../apps/server/src/services/credential-service.ts";
import { openFromString, aad } from "../../apps/server/src/security/encryption.ts";
import type { AppConfig } from "../../apps/server/src/config.ts";

function setup() {
  const db = openMemoryDatabase();
  runMigrations(db);
  const users = new UsersRepository(db);
  const repo = new S3CredentialsRepository(db);
  const config = { masterEncryptionKey: Buffer.alloc(32, 5) } as AppConfig;
  const audit = new AuditLogsRepository(db);
  const svc = new CredentialService(repo, config, db, audit);
  const userA = users.upsertOnLogin({
    googleSub: "sa",
    email: "a@x.com",
    displayName: "A",
    hostedDomain: "x.com",
  });
  const userB = users.upsertOnLogin({
    googleSub: "sb",
    email: "b@x.com",
    displayName: "B",
    hostedDomain: "x.com",
  });
  return { db, repo, svc, config, userA, userB };
}

describe("CredentialService", () => {
  test("create returns secret once and stores it encrypted", () => {
    const { svc, repo, config, userA } = setup();
    const created = svc.create(userA.id, "my key");
    expect(created.secretAccessKey.length).toBe(40);
    expect(created.accessKeyId.length).toBe(20);

    const row = repo.findByIdOwned(userA.id, created.id)!;
    // stored value is not the plaintext secret
    expect(row.encrypted_secret_key).not.toContain(created.secretAccessKey);
    // but decrypts back to it with the right AAD
    const decrypted = openFromString(
      row.encrypted_secret_key,
      config.masterEncryptionKey,
      aad.s3Secret(created.id),
    );
    expect(decrypted).toBe(created.secretAccessKey);
  });

  test("list never exposes the encrypted secret field", () => {
    const { svc, userA } = setup();
    svc.create(userA.id, "k");
    const list = svc.list(userA.id);
    expect(list.length).toBe(1);
    expect(list[0]).toBeDefined();
    expect(Object.hasOwn(list[0]!, "encrypted_secret_key")).toBe(false);
  });

  test("ownership isolation: user B cannot see or revoke user A's key", () => {
    const { svc, repo, userA, userB } = setup();
    const created = svc.create(userA.id, "k");
    expect(repo.findByIdOwned(userB.id, created.id)).toBeNull();
    expect(svc.revoke(userB.id, created.id)).toBe(false);
    // still active for A
    expect(repo.findByIdOwned(userA.id, created.id)!.status).toBe("active");
  });

  test("revoke deactivates and blocks lookup by SigV4 finder", () => {
    const { svc, repo, userA } = setup();
    const created = svc.create(userA.id, "k");
    expect(repo.findActiveByAccessKeyId(created.accessKeyId)).not.toBeNull();
    expect(svc.revoke(userA.id, created.id)).toBe(true);
    expect(repo.findActiveByAccessKeyId(created.accessKeyId)).toBeNull();
  });

  test("rotates atomically and deletes only after revoke", () => {
    const { svc, repo, db, userA } = setup();
    const original = svc.create(userA.id, "client");
    const rotated = svc.rotateActive(userA.id, original.id, "req-rotate");
    expect(rotated.id).not.toBe(original.id);
    expect(repo.findByIdOwned(userA.id, original.id)?.status).toBe("revoked");
    expect(repo.findActiveByAccessKeyId(rotated.accessKeyId)?.id).toBe(rotated.id);
    expect(() => svc.deleteRevoked(userA.id, rotated.id, "req-delete-active")).toThrow();
    svc.deleteRevoked(userA.id, original.id, "req-delete-old");
    expect(repo.findByIdOwned(userA.id, original.id)).toBeNull();
    const audit = db.query<{ action: string; detail_json: string }, []>(
      "SELECT action, detail_json FROM audit_logs ORDER BY created_at",
    ).all();
    expect(audit.map((row) => row.action)).toEqual(["credential.rotate", "credential.delete"]);
    expect(audit[1]!.detail_json).toContain(original.accessKeyId);
  });
});
