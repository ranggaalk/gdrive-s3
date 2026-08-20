// Signed, opaque continuation tokens for ListObjectsV2 (AGENTS.md §13).
// Payload is a JSON object, base64url-encoded, appended with an HMAC-SHA256
// tag keyed on config.sessionSecret. Any tamper flips the tag and the token
// is rejected. Never expose raw SQL offsets to the client.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface ContinuationPayload {
  b: string; // bucketId
  a: string; // afterKey
  p: string; // prefix
  d: string; // delimiter
  e: number; // exp epoch ms
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;

function sign(secret: Buffer, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("base64url");
}

export function encodeContinuationToken(
  payload: Omit<ContinuationPayload, "e"> & { ttlMs?: number },
  secret: Buffer,
): string {
  const full: ContinuationPayload = {
    b: payload.b,
    a: payload.a,
    p: payload.p,
    d: payload.d,
    e: Date.now() + (payload.ttlMs ?? DEFAULT_TTL_MS),
  };
  const body = Buffer.from(JSON.stringify(full), "utf8").toString("base64url");
  const mac = sign(secret, body);
  return `${body}.${mac}`;
}

export function decodeContinuationToken(
  token: string,
  secret: Buffer,
): ContinuationPayload | null {
  const idx = token.indexOf(".");
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = sign(secret, body);
  const a = Buffer.from(mac, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let parsed: ContinuationPayload;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ContinuationPayload;
  } catch {
    return null;
  }
  if (
    typeof parsed.b !== "string" ||
    typeof parsed.a !== "string" ||
    typeof parsed.p !== "string" ||
    typeof parsed.d !== "string"
  ) return null;
  if (typeof parsed.e !== "number" || parsed.e < Date.now()) return null;
  return parsed;
}
