import { describe, expect, test } from "bun:test";
import { openMemoryDatabase } from "../../apps/server/src/db/connection.ts";
import { runMigrations } from "../../apps/server/src/db/migrate.ts";
import { UsersRepository } from "../../apps/server/src/db/repositories/users.ts";
import { SessionsRepository } from "../../apps/server/src/db/repositories/sessions.ts";
import { SessionService, hashSessionId, readCookie } from "../../apps/server/src/auth/session.ts";
import type { AppConfig } from "../../apps/server/src/config.ts";

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    isProduction: false,
    sessionSecret: Buffer.alloc(32, 1),
    ...overrides,
  } as AppConfig;
}

function setup() {
  const db = openMemoryDatabase();
  runMigrations(db);
  const users = new UsersRepository(db);
  const sessions = new SessionsRepository(db);
  const user = users.upsertOnLogin({
    googleSub: "sub_1",
    email: "a@example.com",
    displayName: "A",
    hostedDomain: "example.com",
  });
  return { db, sessions, user };
}

describe("SessionService", () => {
  test("establish stores only the hash, cookie has raw id", () => {
    const { sessions, user } = setup();
    const svc = new SessionService(sessions, testConfig());
    const est = svc.establish({ userId: user.id, userAgent: "ua", ip: null });

    expect(est.setCookie).toContain("drives3_sid=");
    expect(est.setCookie).toContain("HttpOnly");
    expect(est.setCookie).toContain("SameSite=Lax");
    expect(est.setCookie).not.toContain("Secure"); // dev

    const rowByHash = sessions.findValid(hashSessionId(est.rawId));
    expect(rowByHash?.user_id).toBe(user.id);
    // raw id is not stored verbatim
    const rowByRaw = sessions.findValid(est.rawId);
    expect(rowByRaw).toBeNull();
  });

  test("Secure flag set in production", () => {
    const { sessions, user } = setup();
    const svc = new SessionService(sessions, testConfig({ isProduction: true }));
    const est = svc.establish({ userId: user.id, userAgent: null, ip: null });
    expect(est.setCookie).toContain("Secure");
  });

  test("resolve returns session then destroy invalidates it", () => {
    const { sessions, user } = setup();
    const svc = new SessionService(sessions, testConfig());
    const est = svc.establish({ userId: user.id, userAgent: null, ip: null });

    expect(svc.resolve(est.rawId)?.user_id).toBe(user.id);
    const clearCookie = svc.destroy(est.rawId);
    expect(clearCookie).toContain("Max-Age=0");
    expect(svc.resolve(est.rawId)).toBeNull();
  });

  test("resolve returns null for unknown id", () => {
    const { sessions } = setup();
    const svc = new SessionService(sessions, testConfig());
    expect(svc.resolve("nope")).toBeNull();
    expect(svc.resolve(null)).toBeNull();
  });
});

describe("readCookie", () => {
  test("parses a named cookie", () => {
    expect(readCookie("a=1; drives3_sid=xyz; b=2", "drives3_sid")).toBe("xyz");
  });
  test("returns null when absent", () => {
    expect(readCookie("a=1", "drives3_sid")).toBeNull();
    expect(readCookie(null, "drives3_sid")).toBeNull();
  });
});
