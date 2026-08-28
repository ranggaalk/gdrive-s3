// A local key-management service: customer master keys (CMKs) that wrap
// per-object data keys.
//
// This is envelope encryption. Each object gets its own random data key; that
// key is encrypted ("wrapped") under a CMK and stored beside the object. The
// CMK itself never leaves this process in plaintext — at rest it is encrypted
// under MASTER_ENCRYPTION_KEY with a purpose-binding AAD, exactly like refresh
// tokens and TOTP secrets already are.
//
// Why per-object data keys rather than encrypting straight under the CMK:
// rotating a CMK then only has to rewrap the small data keys, never rewrite
// object bytes, and a single leaked data key exposes one object rather than
// the whole bucket.

import type { AppConfig } from "../config.ts";
import type {
  KmsKeyRow,
  KmsKeysRepository,
} from "../db/repositories/kms-keys.ts";
import { aad, openFromString, sealToString } from "./encryption.ts";
import { generateDataKey } from "./object-crypto.ts";

export class KmsKeyNotFoundError extends Error {
  constructor() {
    super("KMS key not found");
    this.name = "KmsKeyNotFoundError";
  }
}

export class KmsKeyDisabledError extends Error {
  constructor() {
    super("KMS key is disabled");
    this.name = "KmsKeyDisabledError";
  }
}

export interface GeneratedDataKey {
  /** Plaintext data key. Callers must zero it once the stream is set up. */
  plaintext: Buffer;
  /** The same key encrypted under the CMK, safe to store. */
  wrapped: string;
  kmsKeyId: string;
}

export class KmsService {
  constructor(
    private readonly config: AppConfig,
    private readonly keys: KmsKeysRepository,
  ) {}

  list(userId: string): KmsKeyRow[] {
    return this.keys.listForUser(userId);
  }

  /** Create a CMK. The key material is random and never leaves this process
   *  in the clear. */
  create(input: { userId: string; alias: string }): KmsKeyRow {
    const material = generateDataKey();
    try {
      const id = this.keys.nextId();
      return this.keys.create({
        id,
        userId: input.userId,
        alias: input.alias,
        encryptedMaterial: sealToString(
          material.toString("base64"),
          this.config.masterEncryptionKey,
          aad.kmsKey(id),
        ),
      });
    } finally {
      material.fill(0);
    }
  }

  /**
   * Rotate a CMK: new material for future writes, while every existing object
   * keeps decrypting. Objects record the key *version* they were written
   * under, and the superseded material is retained so those reads keep
   * working — rotation must never strand data.
   */
  rotate(userId: string, kmsKeyId: string): KmsKeyRow {
    const existing = this.keys.findOwned(userId, kmsKeyId);
    if (!existing) throw new KmsKeyNotFoundError();
    const material = generateDataKey();
    try {
      return this.keys.rotate({
        id: kmsKeyId,
        encryptedMaterial: sealToString(
          material.toString("base64"),
          this.config.masterEncryptionKey,
          aad.kmsKey(kmsKeyId),
        ),
      });
    } finally {
      material.fill(0);
    }
  }

  setStatus(userId: string, kmsKeyId: string, status: "active" | "disabled"): KmsKeyRow {
    const existing = this.keys.findOwned(userId, kmsKeyId);
    if (!existing) throw new KmsKeyNotFoundError();
    return this.keys.setStatus(kmsKeyId, status);
  }

  /** Generate a fresh data key wrapped under the given CMK. */
  generateDataKey(userId: string, kmsKeyId: string): GeneratedDataKey {
    const cmk = this.keys.findOwned(userId, kmsKeyId);
    if (!cmk) throw new KmsKeyNotFoundError();
    if (cmk.status !== "active") throw new KmsKeyDisabledError();

    const plaintext = generateDataKey();
    const master = this.unwrapCmk(cmk);
    try {
      return {
        plaintext,
        wrapped: sealToString(
          plaintext.toString("base64"),
          master,
          aad.kmsDataKey(cmk.id, cmk.version),
        ),
        kmsKeyId: cmk.id,
      };
    } finally {
      master.fill(0);
    }
  }

  /**
   * Recover a wrapped data key.
   *
   * `version` is the CMK version the object was written under; a rotated key
   * still decrypts its older objects because the superseded material is kept.
   */
  decryptDataKey(input: {
    kmsKeyId: string;
    version: number;
    wrapped: string;
  }): Buffer {
    const cmk = this.keys.findById(input.kmsKeyId);
    if (!cmk) throw new KmsKeyNotFoundError();

    const material = this.unwrapCmkVersion(cmk, input.version);
    try {
      return Buffer.from(
        openFromString(input.wrapped, material, aad.kmsDataKey(input.kmsKeyId, input.version)),
        "base64",
      );
    } finally {
      material.fill(0);
    }
  }

  private unwrapCmk(cmk: KmsKeyRow): Buffer {
    return this.unwrapCmkVersion(cmk, cmk.version);
  }

  private unwrapCmkVersion(cmk: KmsKeyRow, version: number): Buffer {
    const encrypted =
      version === cmk.version
        ? cmk.encrypted_material
        : this.keys.findVersionMaterial(cmk.id, version);
    if (!encrypted) throw new KmsKeyNotFoundError();
    return Buffer.from(
      openFromString(encrypted, this.config.masterEncryptionKey, aad.kmsKey(cmk.id)),
      "base64",
    );
  }
}
