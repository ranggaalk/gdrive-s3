import { describe, expect, test } from "bun:test";
import {
  encrypt,
  decrypt,
  sealToString,
  openFromString,
  constantTimeEqual,
  aad,
} from "../../apps/server/src/security/encryption.ts";

const key = Buffer.alloc(32, 3);
const otherKey = Buffer.alloc(32, 9);

describe("AES-256-GCM envelope", () => {
  test("roundtrip preserves plaintext", () => {
    const ctx = aad.oauthRefreshToken("usr_1");
    const env = encrypt("super-secret-token", key, ctx);
    expect(env.v).toBe(1);
    expect(env.alg).toBe("A256GCM");
    expect(decrypt(env, key, ctx)).toBe("super-secret-token");
  });

  test("unique IV per encryption", () => {
    const ctx = aad.s3Secret("akc_1");
    const a = encrypt("x", key, ctx);
    const b = encrypt("x", key, ctx);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test("wrong key fails", () => {
    const ctx = aad.oauthRefreshToken("usr_1");
    const env = encrypt("data", key, ctx);
    expect(() => decrypt(env, otherKey, ctx)).toThrow();
  });

  test("wrong AAD fails (context binding)", () => {
    const env = encrypt("data", key, aad.oauthRefreshToken("usr_1"));
    expect(() => decrypt(env, key, aad.oauthRefreshToken("usr_2"))).toThrow();
  });

  test("tampered ciphertext is rejected", () => {
    const ctx = aad.s3Secret("akc_1");
    const env = encrypt("data", key, ctx);
    const tampered = { ...env, ciphertext: Buffer.from("bogusbytes").toString("base64") };
    expect(() => decrypt(tampered, key, ctx)).toThrow();
  });

  test("tampered tag is rejected", () => {
    const ctx = aad.s3Secret("akc_1");
    const env = encrypt("data", key, ctx);
    const badTag = Buffer.alloc(16, 0).toString("base64");
    expect(() => decrypt({ ...env, tag: badTag }, key, ctx)).toThrow();
  });

  test("seal/open string roundtrip", () => {
    const ctx = aad.oauthRefreshToken("usr_x");
    const sealed = sealToString("refresh-abc", key, ctx);
    expect(typeof sealed).toBe("string");
    expect(openFromString(sealed, key, ctx)).toBe("refresh-abc");
  });

  test("rejects non-32-byte key", () => {
    expect(() => encrypt("x", Buffer.alloc(16), "ctx")).toThrow();
  });
});

describe("constantTimeEqual", () => {
  test("true for equal strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });
  test("false for different strings", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });
  test("false for different length", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});
