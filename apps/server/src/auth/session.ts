// Session lifecycle (AGENTS.md §7, §20). The raw session id lives only in the
// cookie; the DB stores its SHA-256 hash. Cookies are HttpOnly, SameSite=Lax,
// Secure in production. Session id is rotated after login (fixation protection).

import { createHash, randomBytes } from "node:crypto";
import type { AppConfig } from "../config.ts";
import { SessionsRepository } from "../db/repositories/sessions.ts";
import type { SessionRow } from "../db/repositories/sessions.ts";

export const SESSION_COOKIE = "drives3_sid";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export function hashSessionId(rawId: string): string {
  return createHash("sha256").update(rawId, "utf8").digest("hex");
}

export function hashIp(ip: string | null, secret: Buffer): string | null {
  if (!ip) return null;
  return createHash("sha256").update(secret).update(ip, "utf8").digest("hex");
}

function generateRawId(): string {
  return randomBytes(32).toString("base64url");
}

function generateCsrfSecret(): string {
  return randomBytes(32).toString("base64url");
}

export interface EstablishedSession {
  rawId: string;
  csrfSecret: string;
  expiresAt: string;
  setCookie: string;
}

export interface EstablishInput {
  userId: string;
  userAgent: string | null;
  ip: string | null;
}

export class SessionService {
  constructor(
    private readonly repo: SessionsRepository,
    private readonly config: AppConfig,
  ) {}

  private buildSetCookie(rawId: string, maxAgeSeconds: number): string {
    const parts = [
      `${SESSION_COOKIE}=${rawId}`,
      "HttpOnly",
      "Path=/",
      "SameSite=Lax",
      `Max-Age=${maxAgeSeconds}`,
    ];
    if (this.config.isProduction) parts.push("Secure");
    return parts.join("; ");
  }

  /** Create a fresh session and return the Set-Cookie header. */
  establish(input: EstablishInput): EstablishedSession {
    const rawId = generateRawId();
    const csrfSecret = generateCsrfSecret();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    this.repo.create({
      idHash: hashSessionId(rawId),
      userId: input.userId,
      csrfSecret,
      expiresAt,
      userAgent: input.userAgent,
      ipHash: hashIp(input.ip, this.config.sessionSecret),
    });
    return {
      rawId,
      csrfSecret,
      expiresAt,
      setCookie: this.buildSetCookie(rawId, Math.floor(SESSION_TTL_MS / 1000)),
    };
  }

  /** Resolve a raw cookie value to a live session, touching last_seen. */
  resolve(rawId: string | null): SessionRow | null {
    if (!rawId) return null;
    const row = this.repo.findValid(hashSessionId(rawId));
    if (!row) return null;
    this.repo.touch(row.id_hash);
    return row;
  }

  destroy(rawId: string): string {
    this.repo.delete(hashSessionId(rawId));
    return this.buildSetCookie("", 0);
  }
}

/** Parse a single cookie value from a Cookie header. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return part.slice(idx + 1).trim();
  }
  return null;
}
