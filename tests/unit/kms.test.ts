import { beforeEach, describe, expect, test } from "bun:test";
import { openMemoryDatabase } from "../../apps/server/src/db/connection.ts";
import { runMigrations } from "../../apps/server/src/db/migrate.ts";
import {
  KmsAliasConflictError,
  KmsKeysRepository,
} from "../../apps/server/src/db/repositories/kms-keys.ts";
import { UsersRepository } from "../../apps/server/src/db/repositories/users.ts";
import {
  KmsKeyDisabledError,
  KmsKeyNotFoundError,
  KmsService,
} from "../../apps/server/src/security/kms.ts";
import type { AppConfig } from "../../apps/server/src/config.ts";

const config = { masterEncryptionKey: Buffer.alloc(32, 3) } as AppConfig;

function makeKms() {
  const db = openMemoryDatabase();
  runMigrations(db);
  const users = new UsersRepository(db);
  const owner = users.upsertOnLogin({
    googleSub: "sub-owner",
    email: "owner@x.com",
    displayName: null,
    hostedDomain: "x.com",
  });
  const other = users.upsertOnLogin({
    googleSub: "sub-other",
    email: "other@x.com",
    displayName: null,
    hostedDomain: "x.com",
  });
  const repo = new KmsKeysRepository(db);
  return { db, repo, kms: new KmsService(config, repo), owner, other };
}

let harness: ReturnType<typeof makeKms>;
beforeEach(() => {
  harness = makeKms();
});

describe("CMK lifecycle", () => {
  test("creates a key whose material is never stored in the clear", () => {
    const { kms, repo, owner } = harness;
    const key = kms.create({ userId: owner.id, alias: "primary" });
    expect(key.alias).toBe("primary");
    expect(key.version).toBe(1);
    expect(key.status).toBe("active");

    const stored = repo.findById(key.id)!;
    const envelope = JSON.parse(stored.encrypted_material) as Record<string, unknown>;
    expect(envelope["alg"]).toBe("A256GCM");
    expect(envelope).toHaveProperty("ciphertext");
    expect(stored.encrypted_material).not.toContain("=".repeat(10));
  });

  test("aliases are unique per user but not across users", () => {
    const { kms, owner, other } = harness;
    kms.create({ userId: owner.id, alias: "shared-name" });
    expect(() => kms.create({ userId: owner.id, alias: "shared-name" })).toThrow(
      KmsAliasConflictError,
    );
    // A different owner may reuse the alias.
    expect(kms.create({ userId: other.id, alias: "shared-name" }).alias).toBe("shared-name");
  });

  test("lists only the owner's keys", () => {
    const { kms, owner, other } = harness;
    kms.create({ userId: owner.id, alias: "mine" });
    kms.create({ userId: other.id, alias: "theirs" });
    expect(kms.list(owner.id).map((k) => k.alias)).toEqual(["mine"]);
  });

  test("disabling blocks new writes but is reversible", () => {
    const { kms, owner } = harness;
    const key = kms.create({ userId: owner.id, alias: "primary" });

    kms.setStatus(owner.id, key.id, "disabled");
    expect(() => kms.generateDataKey(owner.id, key.id)).toThrow(KmsKeyDisabledError);

    kms.setStatus(owner.id, key.id, "active");
    expect(kms.generateDataKey(owner.id, key.id).plaintext).toHaveLength(32);
  });

  test("another user cannot touch a key they do not own", () => {
    const { kms, owner, other } = harness;
    const key = kms.create({ userId: owner.id, alias: "primary" });
    expect(() => kms.generateDataKey(other.id, key.id)).toThrow(KmsKeyNotFoundError);
    expect(() => kms.rotate(other.id, key.id)).toThrow(KmsKeyNotFoundError);
    expect(() => kms.setStatus(other.id, key.id, "disabled")).toThrow(KmsKeyNotFoundError);
  });
});

describe("data keys", () => {
  test("each generated data key is distinct and unwraps to itself", () => {
    const { kms, owner } = harness;
    const cmk = kms.create({ userId: owner.id, alias: "primary" });

    const first = kms.generateDataKey(owner.id, cmk.id);
    const second = kms.generateDataKey(owner.id, cmk.id);
    expect(first.plaintext.equals(second.plaintext)).toBe(false);
    expect(first.wrapped).not.toBe(second.wrapped);

    const recovered = kms.decryptDataKey({
      kmsKeyId: cmk.id,
      version: 1,
      wrapped: first.wrapped,
    });
    expect(recovered.equals(first.plaintext)).toBe(true);
  });

  test("a wrapped key cannot be opened under the wrong CMK", () => {
    const { kms, owner } = harness;
    const a = kms.create({ userId: owner.id, alias: "a" });
    const b = kms.create({ userId: owner.id, alias: "b" });
    const wrapped = kms.generateDataKey(owner.id, a.id).wrapped;
    expect(() => kms.decryptDataKey({ kmsKeyId: b.id, version: 1, wrapped })).toThrow();
  });

  test("a wrapped key cannot be opened under the wrong version", () => {
    const { kms, owner } = harness;
    const cmk = kms.create({ userId: owner.id, alias: "primary" });
    const wrapped = kms.generateDataKey(owner.id, cmk.id).wrapped;
    kms.rotate(owner.id, cmk.id);
    // The AAD binds the version, so claiming v2 for a v1 key fails the tag.
    expect(() => kms.decryptDataKey({ kmsKeyId: cmk.id, version: 2, wrapped })).toThrow();
  });
});

describe("rotation", () => {
  test("bumps the version and records the rotation time", () => {
    const { kms, owner } = harness;
    const cmk = kms.create({ userId: owner.id, alias: "primary" });
    expect(cmk.rotated_at).toBeNull();

    const rotated = kms.rotate(owner.id, cmk.id);
    expect(rotated.version).toBe(2);
    expect(rotated.rotated_at).toBeTruthy();
    expect(rotated.encrypted_material).not.toBe(cmk.encrypted_material);
  });

  test("data keys written before a rotation still decrypt afterwards", () => {
    const { kms, owner } = harness;
    const cmk = kms.create({ userId: owner.id, alias: "primary" });
    const beforeRotation = kms.generateDataKey(owner.id, cmk.id);

    kms.rotate(owner.id, cmk.id);

    // This is the property that matters: rotation must never strand data.
    const recovered = kms.decryptDataKey({
      kmsKeyId: cmk.id,
      version: 1,
      wrapped: beforeRotation.wrapped,
    });
    expect(recovered.equals(beforeRotation.plaintext)).toBe(true);
  });

  test("survives repeated rotations, with every generation still readable", () => {
    const { kms, owner } = harness;
    const cmk = kms.create({ userId: owner.id, alias: "primary" });

    const generations: Array<{ version: number; wrapped: string; plaintext: Buffer }> = [];
    for (let version = 1; version <= 5; version++) {
      const generated = kms.generateDataKey(owner.id, cmk.id);
      generations.push({ version, wrapped: generated.wrapped, plaintext: generated.plaintext });
      kms.rotate(owner.id, cmk.id);
    }

    for (const generation of generations) {
      const recovered = kms.decryptDataKey({
        kmsKeyId: cmk.id,
        version: generation.version,
        wrapped: generation.wrapped,
      });
      expect(recovered.equals(generation.plaintext)).toBe(true);
    }
  });

  test("new data keys use the rotated material", () => {
    const { kms, repo, owner } = harness;
    const cmk = kms.create({ userId: owner.id, alias: "primary" });
    kms.rotate(owner.id, cmk.id);

    const generated = kms.generateDataKey(owner.id, cmk.id);
    expect(repo.findById(cmk.id)!.version).toBe(2);
    // Recovering it requires naming version 2.
    expect(
      kms.decryptDataKey({ kmsKeyId: cmk.id, version: 2, wrapped: generated.wrapped })
        .equals(generated.plaintext),
    ).toBe(true);
  });

  test("rotating a key that does not exist is refused", () => {
    const { kms, owner } = harness;
    expect(() => kms.rotate(owner.id, "kms_missing")).toThrow(KmsKeyNotFoundError);
  });
});
