import { describe, expect, test } from "bun:test";
import {
  assertDeletable,
  bypassRequested,
  canReplaceRetention,
  evaluateDelete,
  isLockMode,
  legalHoldActive,
  parseLegalHoldXml,
  parseLockHeaders,
  parseRetentionXml,
  resolveDefaultRetention,
  retentionActive,
  type LockState,
} from "../../apps/server/src/s3/object-lock.ts";
import { S3Error } from "../../apps/server/src/s3/errors.ts";

const NOW = Date.parse("2026-06-01T00:00:00.000Z");
const FUTURE = "2026-12-01T00:00:00.000Z";
const PAST = "2026-01-01T00:00:00.000Z";

function state(overrides: Partial<LockState> = {}): LockState {
  return { lock_mode: null, retain_until: null, legal_hold: 0, ...overrides };
}

describe("retentionActive", () => {
  test("is false when no retention is set", () => {
    expect(retentionActive(state(), NOW)).toBe(false);
  });

  test("is true while the date is in the future", () => {
    expect(retentionActive(state({ lock_mode: "GOVERNANCE", retain_until: FUTURE }), NOW)).toBe(true);
  });

  test("is false once the date has passed", () => {
    expect(retentionActive(state({ lock_mode: "GOVERNANCE", retain_until: PAST }), NOW)).toBe(false);
  });

  test("treats a malformed date as still retained rather than failing open", () => {
    // A corrupt row must not become a way to delete protected data.
    expect(retentionActive(state({ lock_mode: "COMPLIANCE", retain_until: "garbage" }), NOW)).toBe(true);
  });

  test("needs both halves to be set", () => {
    expect(retentionActive(state({ lock_mode: "GOVERNANCE" }), NOW)).toBe(false);
    expect(retentionActive(state({ retain_until: FUTURE }), NOW)).toBe(false);
  });
});

describe("legalHoldActive", () => {
  test("reflects the flag", () => {
    expect(legalHoldActive(state())).toBe(false);
    expect(legalHoldActive(state({ legal_hold: 1 }))).toBe(true);
  });
});

describe("evaluateDelete", () => {
  const owner = { bypassGovernance: false, isBucketOwner: true, now: NOW };

  test("allows deleting an unlocked version", () => {
    expect(evaluateDelete({ state: state(), ...owner })).toEqual({ allowed: true });
  });

  test("allows deleting once retention has expired", () => {
    expect(
      evaluateDelete({ state: state({ lock_mode: "COMPLIANCE", retain_until: PAST }), ...owner }),
    ).toEqual({ allowed: true });
  });

  test("a legal hold blocks deletion regardless of retention", () => {
    expect(evaluateDelete({ state: state({ legal_hold: 1 }), ...owner })).toEqual({
      allowed: false,
      reason: "legal-hold",
    });
  });

  test("a legal hold is not bypassable, even by the owner", () => {
    expect(
      evaluateDelete({
        state: state({ legal_hold: 1 }),
        bypassGovernance: true,
        isBucketOwner: true,
        now: NOW,
      }),
    ).toEqual({ allowed: false, reason: "legal-hold" });
  });

  test("GOVERNANCE blocks deletion without a bypass", () => {
    expect(
      evaluateDelete({ state: state({ lock_mode: "GOVERNANCE", retain_until: FUTURE }), ...owner }),
    ).toEqual({ allowed: false, reason: "governance" });
  });

  test("GOVERNANCE yields to a bypass from the bucket owner", () => {
    expect(
      evaluateDelete({
        state: state({ lock_mode: "GOVERNANCE", retain_until: FUTURE }),
        bypassGovernance: true,
        isBucketOwner: true,
        now: NOW,
      }),
    ).toEqual({ allowed: true });
  });

  test("a bypass from someone who is not the bucket owner is ignored", () => {
    expect(
      evaluateDelete({
        state: state({ lock_mode: "GOVERNANCE", retain_until: FUTURE }),
        bypassGovernance: true,
        isBucketOwner: false,
        now: NOW,
      }),
    ).toEqual({ allowed: false, reason: "governance" });
  });

  test("COMPLIANCE can never be bypassed", () => {
    expect(
      evaluateDelete({
        state: state({ lock_mode: "COMPLIANCE", retain_until: FUTURE }),
        bypassGovernance: true,
        isBucketOwner: true,
        now: NOW,
      }),
    ).toEqual({ allowed: false, reason: "compliance" });
  });
});

describe("assertDeletable", () => {
  test("passes an allowed decision", () => {
    expect(() => assertDeletable({ allowed: true })).not.toThrow();
  });

  test("throws a distinct reason for each block", () => {
    for (const reason of ["legal-hold", "compliance", "governance"] as const) {
      expect(() => assertDeletable({ allowed: false, reason })).toThrow(S3Error);
    }
  });
});

describe("canReplaceRetention", () => {
  const base = { bypassGovernance: false, isBucketOwner: true, now: NOW };

  test("any retention may be set when none is active", () => {
    expect(
      canReplaceRetention({
        current: state(),
        nextRetainUntil: FUTURE,
        nextMode: "GOVERNANCE",
        ...base,
      }),
    ).toBe(true);
  });

  test("extending is always allowed", () => {
    expect(
      canReplaceRetention({
        current: state({ lock_mode: "GOVERNANCE", retain_until: "2026-07-01T00:00:00.000Z" }),
        nextRetainUntil: FUTURE,
        nextMode: "GOVERNANCE",
        ...base,
      }),
    ).toBe(true);
    expect(
      canReplaceRetention({
        current: state({ lock_mode: "COMPLIANCE", retain_until: "2026-07-01T00:00:00.000Z" }),
        nextRetainUntil: FUTURE,
        nextMode: "COMPLIANCE",
        ...base,
      }),
    ).toBe(true);
  });

  test("shortening a GOVERNANCE lock needs an owner bypass", () => {
    const current = state({ lock_mode: "GOVERNANCE", retain_until: FUTURE });
    const shorter = "2026-07-01T00:00:00.000Z";
    expect(canReplaceRetention({ current, nextRetainUntil: shorter, nextMode: "GOVERNANCE", ...base })).toBe(false);
    expect(
      canReplaceRetention({
        current,
        nextRetainUntil: shorter,
        nextMode: "GOVERNANCE",
        bypassGovernance: true,
        isBucketOwner: true,
        now: NOW,
      }),
    ).toBe(true);
    // Not the owner: the bypass does nothing.
    expect(
      canReplaceRetention({
        current,
        nextRetainUntil: shorter,
        nextMode: "GOVERNANCE",
        bypassGovernance: true,
        isBucketOwner: false,
        now: NOW,
      }),
    ).toBe(false);
  });

  test("a COMPLIANCE lock can never be shortened", () => {
    expect(
      canReplaceRetention({
        current: state({ lock_mode: "COMPLIANCE", retain_until: FUTURE }),
        nextRetainUntil: "2026-07-01T00:00:00.000Z",
        nextMode: "COMPLIANCE",
        bypassGovernance: true,
        isBucketOwner: true,
        now: NOW,
      }),
    ).toBe(false);
  });

  test("COMPLIANCE cannot be downgraded to GOVERNANCE even while extending", () => {
    // Otherwise the lock could be made bypassable and then lifted.
    expect(
      canReplaceRetention({
        current: state({ lock_mode: "COMPLIANCE", retain_until: "2026-07-01T00:00:00.000Z" }),
        nextRetainUntil: FUTURE,
        nextMode: "GOVERNANCE",
        bypassGovernance: true,
        isBucketOwner: true,
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe("resolveDefaultRetention", () => {
  const now = new Date(NOW);

  test("returns null when no default is configured", () => {
    expect(resolveDefaultRetention(null, now)).toBeNull();
  });

  test("resolves a day-based default", () => {
    const resolved = resolveDefaultRetention('{"mode":"GOVERNANCE","days":30}', now)!;
    expect(resolved.mode).toBe("GOVERNANCE");
    expect(Date.parse(resolved.retainUntil) - NOW).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test("resolves a year-based default", () => {
    const resolved = resolveDefaultRetention('{"mode":"COMPLIANCE","years":1}', now)!;
    expect(Date.parse(resolved.retainUntil) - NOW).toBe(365 * 24 * 60 * 60 * 1000);
  });

  test("rejects malformed or nonsensical defaults", () => {
    for (const raw of [
      "not json",
      "{}",
      '{"mode":"NONSENSE","days":1}',
      '{"mode":"GOVERNANCE"}',
      '{"mode":"GOVERNANCE","days":0}',
      '{"mode":"GOVERNANCE","days":-5}',
    ]) {
      expect(resolveDefaultRetention(raw, now)).toBeNull();
    }
  });
});

describe("XML parsing", () => {
  test("parses a retention document", () => {
    const parsed = parseRetentionXml(
      `<Retention><Mode>COMPLIANCE</Mode><RetainUntilDate>${FUTURE}</RetainUntilDate></Retention>`,
    );
    expect(parsed.mode).toBe("COMPLIANCE");
    expect(parsed.retainUntil).toBe(FUTURE);
  });

  test("rejects a bad mode or date", () => {
    expect(() =>
      parseRetentionXml(`<Retention><Mode>LOOSE</Mode><RetainUntilDate>${FUTURE}</RetainUntilDate></Retention>`),
    ).toThrow(S3Error);
    expect(() =>
      parseRetentionXml("<Retention><Mode>GOVERNANCE</Mode><RetainUntilDate>soon</RetainUntilDate></Retention>"),
    ).toThrow(S3Error);
  });

  test("parses a legal hold document", () => {
    expect(parseLegalHoldXml("<LegalHold><Status>ON</Status></LegalHold>")).toBe(true);
    expect(parseLegalHoldXml("<LegalHold><Status>OFF</Status></LegalHold>")).toBe(false);
    expect(() => parseLegalHoldXml("<LegalHold><Status>MAYBE</Status></LegalHold>")).toThrow(S3Error);
  });
});

describe("parseLockHeaders", () => {
  test("returns nothing when no lock headers are present", () => {
    expect(parseLockHeaders(new Headers())).toEqual({
      mode: null,
      retainUntil: null,
      legalHold: false,
    });
  });

  test("parses a full retention request", () => {
    const parsed = parseLockHeaders(
      new Headers({
        "x-amz-object-lock-mode": "GOVERNANCE",
        "x-amz-object-lock-retain-until-date": FUTURE,
        "x-amz-object-lock-legal-hold": "ON",
      }),
    );
    expect(parsed).toEqual({ mode: "GOVERNANCE", retainUntil: FUTURE, legalHold: true });
  });

  test("a legal hold alone is valid", () => {
    expect(
      parseLockHeaders(new Headers({ "x-amz-object-lock-legal-hold": "ON" })),
    ).toEqual({ mode: null, retainUntil: null, legalHold: true });
  });

  test("rejects half a retention", () => {
    expect(() =>
      parseLockHeaders(new Headers({ "x-amz-object-lock-mode": "GOVERNANCE" })),
    ).toThrow(S3Error);
    expect(() =>
      parseLockHeaders(new Headers({ "x-amz-object-lock-retain-until-date": FUTURE })),
    ).toThrow(S3Error);
  });

  test("rejects invalid values", () => {
    expect(() =>
      parseLockHeaders(
        new Headers({
          "x-amz-object-lock-mode": "LOOSE",
          "x-amz-object-lock-retain-until-date": FUTURE,
        }),
      ),
    ).toThrow(S3Error);
    expect(() =>
      parseLockHeaders(
        new Headers({
          "x-amz-object-lock-mode": "GOVERNANCE",
          "x-amz-object-lock-retain-until-date": "whenever",
        }),
      ),
    ).toThrow(S3Error);
    expect(() =>
      parseLockHeaders(new Headers({ "x-amz-object-lock-legal-hold": "yes" })),
    ).toThrow(S3Error);
  });
});

describe("bypassRequested", () => {
  test("reads the bypass header case-insensitively", () => {
    expect(bypassRequested(new Headers())).toBe(false);
    expect(bypassRequested(new Headers({ "x-amz-bypass-governance-retention": "true" }))).toBe(true);
    expect(bypassRequested(new Headers({ "x-amz-bypass-governance-retention": "TRUE" }))).toBe(true);
    expect(bypassRequested(new Headers({ "x-amz-bypass-governance-retention": "false" }))).toBe(false);
  });
});

describe("isLockMode", () => {
  test("accepts only the two real modes", () => {
    expect(isLockMode("GOVERNANCE")).toBe(true);
    expect(isLockMode("COMPLIANCE")).toBe(true);
    expect(isLockMode("governance")).toBe(false);
    expect(isLockMode("NONE")).toBe(false);
  });
});
