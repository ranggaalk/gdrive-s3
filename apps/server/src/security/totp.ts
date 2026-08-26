// TOTP (RFC 6238) over HOTP (RFC 4226), HMAC-SHA1 — the algorithm every
// mainstream authenticator app (Google Authenticator, Authy, 1Password, ...)
// expects. SHA1 is otherwise avoided in this codebase, but it's the fixed,
// required algorithm for interoperability here, not a general-purpose choice.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SECRET_BYTES = 20; // 160 bits, the conventional TOTP secret size
const PERIOD_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

function hotp(secret: Buffer, counter: number, digits: number): string {
  if (!Number.isFinite(counter) || counter < 0) {
    throw new RangeError("HOTP counter must be a non-negative finite number");
  }
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(Math.floor(counter)));

  const hmac = createHmac("sha1", secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const truncated =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  const code = String(truncated % 10 ** digits);
  return code.padStart(digits, "0");
}

export function generateTotpCode(
  secret: Buffer,
  forTimeMs: number = Date.now(),
  periodSeconds = PERIOD_SECONDS,
  digits = DIGITS,
): string {
  const counter = Math.floor(forTimeMs / 1000 / periodSeconds);
  return hotp(secret, counter, digits);
}

/**
 * Accepts the current 30s step and one step on either side (±30s of clock
 * drift/typing lag) — the conventional TOTP verification window.
 */
export function verifyTotpCode(
  secret: Buffer,
  code: string,
  forTimeMs: number = Date.now(),
  windowSteps = 1,
  periodSeconds = PERIOD_SECONDS,
  digits = DIGITS,
): boolean {
  const normalized = code.trim();
  if (!/^\d+$/.test(normalized) || normalized.length !== digits) return false;
  const counter = Math.floor(forTimeMs / 1000 / periodSeconds);
  for (let delta = -windowSteps; delta <= windowSteps; delta++) {
    const candidateCounter = counter + delta;
    if (candidateCounter < 0) continue; // no HOTP counter exists before the epoch
    const candidate = hotp(secret, candidateCounter, digits);
    if (constantTimeStringEqual(candidate, normalized)) return true;
  }
  return false;
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function buildOtpauthUri(input: { secret: Buffer; accountLabel: string; issuer: string }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.accountLabel}`);
  const params = new URLSearchParams({
    secret: base32Encode(input.secret),
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

const RECOVERY_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/I ambiguity

export function generateRecoveryCode(): string {
  const bytes = randomBytes(10);
  let out = "";
  for (const byte of bytes) out += RECOVERY_CODE_ALPHABET[byte % RECOVERY_CODE_ALPHABET.length];
  return `${out.slice(0, 5)}-${out.slice(5, 10)}`;
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(code), "utf8").digest("hex");
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
