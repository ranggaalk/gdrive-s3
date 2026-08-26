// Authenticated encryption for sensitive data at rest (AGENTS.md §10).
// AES-256-GCM with a random 12-byte IV and context-binding AAD.
// The auth tag is verified on decrypt; tampering throws.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALG = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface Envelope {
  v: number;
  alg: "A256GCM";
  iv: string; // base64
  ciphertext: string; // base64
  tag: string; // base64
}

/**
 * AAD binds ciphertext to its purpose+owner so a blob can't be moved between
 * contexts. Examples: `oauth-refresh-token:<userId>`, `s3-secret:<credId>`.
 */
export function encrypt(plaintext: string, key: Buffer, aad: string): Envelope {
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: "A256GCM",
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decrypt(envelope: Envelope, key: Buffer, aad: string): string {
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
  if (envelope.v !== 1 || envelope.alg !== "A256GCM") {
    throw new Error("unsupported encryption envelope");
  }
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  if (iv.length !== IV_BYTES) throw new Error("invalid iv length");
  if (tag.length !== TAG_BYTES) throw new Error("invalid tag length");

  const decipher = createDecipheriv(ALG, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  // decipher.final() throws if the tag does not verify.
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/** Serialize an envelope to a compact string for storage in a TEXT column. */
export function sealToString(plaintext: string, key: Buffer, aad: string): string {
  return JSON.stringify(encrypt(plaintext, key, aad));
}

export function openFromString(serialized: string, key: Buffer, aad: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("invalid encrypted envelope json");
  }
  return decrypt(parsed as Envelope, key, aad);
}

/** Constant-time comparison of two secrets given as UTF-8 strings. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** AAD builders keep context strings consistent across the codebase. */
export const aad = {
  oauthRefreshToken: (userId: string) => `oauth-refresh-token:${userId}`,
  s3Secret: (credentialId: string) => `s3-secret:${credentialId}`,
  appSetting: (key: string) => `app-setting:${key}`,
  backupRefreshToken: (backupAccountId: string) => `backup-refresh-token:${backupAccountId}`,
  totpSecret: (userId: string) => `totp-secret:${userId}`,
};
