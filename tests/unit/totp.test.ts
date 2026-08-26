// Verifies the TOTP implementation against RFC 6238 Appendix B's official
// test vectors (SHA1, 8-digit, 30s period, secret = ASCII "12345678901234567890"),
// plus base32 round-tripping and the verification window.

import { describe, expect, test } from "bun:test";
import {
  base32Decode,
  base32Encode,
  generateTotpCode,
  hashRecoveryCode,
  normalizeRecoveryCode,
  verifyTotpCode,
} from "../../apps/server/src/security/totp.ts";

const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

describe("TOTP (RFC 6238 test vectors)", () => {
  const vectors: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  for (const [unixSeconds, expected] of vectors) {
    test(`matches RFC vector at T=${unixSeconds}`, () => {
      const code = generateTotpCode(RFC_SECRET, unixSeconds * 1000, 30, 8);
      expect(code).toBe(expected);
    });
  }

  test("verifyTotpCode accepts the exact current code", () => {
    const code = generateTotpCode(RFC_SECRET, 59_000, 30, 8);
    expect(verifyTotpCode(RFC_SECRET, code, 59_000, 1, 30, 8)).toBe(true);
  });

  test("verifyTotpCode tolerates one step of clock drift either direction", () => {
    const code = generateTotpCode(RFC_SECRET, 59_000, 30, 8); // generated at step 1
    // Verifier's clock one step ahead (checking at step 2): window [1,2,3] still covers step 1.
    expect(verifyTotpCode(RFC_SECRET, code, 59_000 + 30_000, 1, 30, 8)).toBe(true);
    // Verifier's clock one step behind (checking at step 0): window [-1,0,1] still covers step 1.
    expect(verifyTotpCode(RFC_SECRET, code, 59_000 - 30_000, 1, 30, 8)).toBe(true);
  });

  test("verifyTotpCode never throws even when the window would cross before the epoch", () => {
    const code = generateTotpCode(RFC_SECRET, 0, 30, 8); // step 0
    expect(() => verifyTotpCode(RFC_SECRET, code, 0, 1, 30, 8)).not.toThrow();
    expect(verifyTotpCode(RFC_SECRET, code, 0, 1, 30, 8)).toBe(true);
  });

  test("verifyTotpCode rejects a code two steps away", () => {
    const code = generateTotpCode(RFC_SECRET, 59_000, 30, 8);
    expect(verifyTotpCode(RFC_SECRET, code, 59_000 + 90_000, 1, 30, 8)).toBe(false);
  });

  test("verifyTotpCode rejects malformed input", () => {
    expect(verifyTotpCode(RFC_SECRET, "not-a-code", 59_000, 1, 30, 8)).toBe(false);
    expect(verifyTotpCode(RFC_SECRET, "123", 59_000, 1, 30, 8)).toBe(false);
  });

  test("default 6-digit codes are always 6 digits", () => {
    const code = generateTotpCode(RFC_SECRET, Date.now());
    expect(code).toMatch(/^\d{6}$/);
  });
});

describe("base32", () => {
  test("round-trips arbitrary byte sequences", () => {
    for (const input of [
      Buffer.from([]),
      Buffer.from([1]),
      Buffer.from([1, 2, 3, 4, 5]),
      Buffer.from("hello world, this is a longer test payload", "utf8"),
    ]) {
      expect(base32Decode(base32Encode(input))).toEqual(input);
    }
  });

  test("decode ignores separators/whitespace and is case-insensitive", () => {
    const encoded = base32Encode(Buffer.from("test-secret-bytes"));
    const messy = encoded.toLowerCase().match(/.{1,4}/g)!.join("-");
    expect(base32Decode(messy)).toEqual(Buffer.from("test-secret-bytes"));
  });
});

describe("recovery codes", () => {
  test("hashing is deterministic and normalization-insensitive", () => {
    const code = "ABCDE-FGHJK";
    expect(hashRecoveryCode(code)).toBe(hashRecoveryCode(code));
    expect(hashRecoveryCode(code)).toBe(hashRecoveryCode(" abcde-fghjk "));
    expect(hashRecoveryCode(code)).toBe(hashRecoveryCode("abcdefghjk"));
  });

  test("normalize strips separators and uppercases", () => {
    expect(normalizeRecoveryCode(" abcde-fghjk ")).toBe("ABCDEFGHJK");
  });

  test("different codes hash differently", () => {
    expect(hashRecoveryCode("AAAAA-AAAAA")).not.toBe(hashRecoveryCode("BBBBB-BBBBB"));
  });
});
