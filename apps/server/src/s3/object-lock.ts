// Object Lock rules: retention modes, legal hold, and what may be deleted.
//
// The whole feature is a promise that certain bytes cannot be destroyed, so
// the rules live here as pure functions with no I/O — they are the part that
// must be provably right, and they are exercised directly by unit tests rather
// than only through the request path.
//
// Two independent locks can protect a version:
//   Retention  — time-bounded, in one of two modes.
//   Legal hold — indefinite, on/off, independent of any date.
// Either one alone blocks deletion.

import { S3Error } from "./errors.ts";

export type LockMode = "GOVERNANCE" | "COMPLIANCE";

export interface LockState {
  lock_mode: string | null;
  retain_until: string | null;
  legal_hold: number;
}

export interface DefaultRetention {
  mode: LockMode;
  days?: number;
  years?: number;
}

export function isLockMode(value: string): value is LockMode {
  return value === "GOVERNANCE" || value === "COMPLIANCE";
}

/**
 * Whether a version's retention period is still running.
 *
 * A malformed date counts as *still retained*. Failing open here would let a
 * corrupt row become a way to delete protected data, so the safe direction is
 * to keep refusing.
 */
export function retentionActive(state: LockState, now = Date.now()): boolean {
  if (!state.lock_mode || !state.retain_until) return false;
  const until = Date.parse(state.retain_until);
  if (Number.isNaN(until)) return true;
  return until > now;
}

export function legalHoldActive(state: LockState): boolean {
  return state.legal_hold === 1;
}

export type DeleteDecision =
  | { allowed: true }
  | { allowed: false; reason: "legal-hold" | "compliance" | "governance" };

/**
 * May this version be deleted?
 *
 * GOVERNANCE can be overridden with the bypass header, but only by the bucket
 * owner — that is the difference between the two modes, and the reason
 * COMPLIANCE is worth offering at all. A legal hold is never bypassable.
 */
export function evaluateDelete(input: {
  state: LockState;
  bypassGovernance: boolean;
  isBucketOwner: boolean;
  now?: number;
}): DeleteDecision {
  if (legalHoldActive(input.state)) return { allowed: false, reason: "legal-hold" };

  if (!retentionActive(input.state, input.now)) return { allowed: true };

  if (input.state.lock_mode === "COMPLIANCE") {
    // No override exists, by design. Not for the owner, not for an
    // administrator — a COMPLIANCE lock that could be lifted is not one.
    return { allowed: false, reason: "compliance" };
  }

  if (input.bypassGovernance && input.isBucketOwner) return { allowed: true };
  return { allowed: false, reason: "governance" };
}

/** Throw the S3 error a blocked deletion should surface. */
export function assertDeletable(decision: DeleteDecision): void {
  if (decision.allowed) return;
  throw new S3Error("AccessDenied", {
    Reason:
      decision.reason === "legal-hold"
        ? "The object version is under a legal hold."
        : decision.reason === "compliance"
          ? "The object version is protected by a COMPLIANCE retention period."
          : "The object version is protected by a GOVERNANCE retention period.",
  });
}

/**
 * Whether a retention change is permitted.
 *
 * Retention may be extended freely but never shortened, or the lock would be
 * merely advisory. Shortening a GOVERNANCE lock is allowed with a bypass by
 * the owner; a COMPLIANCE lock can only ever be extended.
 */
export function canReplaceRetention(input: {
  current: LockState;
  nextRetainUntil: string;
  nextMode: LockMode;
  bypassGovernance: boolean;
  isBucketOwner: boolean;
  now?: number;
}): boolean {
  if (!retentionActive(input.current, input.now)) return true;

  const currentUntil = Date.parse(input.current.retain_until ?? "");
  const nextUntil = Date.parse(input.nextRetainUntil);
  if (Number.isNaN(nextUntil)) return false;
  // Extending is always fine, in either mode.
  if (!Number.isNaN(currentUntil) && nextUntil >= currentUntil) {
    // COMPLIANCE cannot be downgraded to GOVERNANCE, even while extending —
    // that would be a way to make it bypassable later.
    if (input.current.lock_mode === "COMPLIANCE" && input.nextMode !== "COMPLIANCE") {
      return false;
    }
    return true;
  }

  // Shortening.
  if (input.current.lock_mode === "COMPLIANCE") return false;
  return input.bypassGovernance && input.isBucketOwner;
}

/** Parse a `{"mode":…,"days":…}` bucket default into a concrete expiry. */
export function resolveDefaultRetention(
  raw: string | null,
  now = new Date(),
): { mode: LockMode; retainUntil: string } | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const { mode, days, years } = parsed as Record<string, unknown>;
  if (typeof mode !== "string" || !isLockMode(mode)) return null;

  const dayCount =
    typeof days === "number" && Number.isFinite(days) && days > 0
      ? days
      : typeof years === "number" && Number.isFinite(years) && years > 0
        ? years * 365
        : null;
  if (dayCount === null) return null;

  return {
    mode,
    retainUntil: new Date(now.getTime() + dayCount * 24 * 60 * 60 * 1000).toISOString(),
  };
}

/** Validate a `Retention` XML body, or the equivalent request headers. */
export function parseRetentionXml(
  body: string,
): { mode: LockMode; retainUntil: string } {
  const mode = /<Mode>\s*([^<]*?)\s*<\/Mode>/.exec(body)?.[1];
  const until = /<RetainUntilDate>\s*([^<]*?)\s*<\/RetainUntilDate>/.exec(body)?.[1];
  if (!mode || !isLockMode(mode)) {
    throw new S3Error("MalformedXML", { Reason: "Mode must be GOVERNANCE or COMPLIANCE." });
  }
  if (!until || Number.isNaN(Date.parse(until))) {
    throw new S3Error("MalformedXML", { Reason: "RetainUntilDate must be a valid date." });
  }
  return { mode, retainUntil: new Date(until).toISOString() };
}

/** Validate a `LegalHold` XML body. */
export function parseLegalHoldXml(body: string): boolean {
  const status = /<Status>\s*([^<]*?)\s*<\/Status>/.exec(body)?.[1];
  if (status !== "ON" && status !== "OFF") {
    throw new S3Error("MalformedXML", { Reason: "Status must be ON or OFF." });
  }
  return status === "ON";
}

/** The lock a PUT is asking for, from its headers. */
export function parseLockHeaders(headers: Headers): {
  mode: LockMode | null;
  retainUntil: string | null;
  legalHold: boolean;
} {
  const rawMode = headers.get("x-amz-object-lock-mode");
  const rawUntil = headers.get("x-amz-object-lock-retain-until-date");
  const rawHold = headers.get("x-amz-object-lock-legal-hold");

  if (rawMode !== null && !isLockMode(rawMode)) {
    throw new S3Error("InvalidArgument", { ArgumentName: "x-amz-object-lock-mode" });
  }
  // Neither half of a retention is meaningful without the other.
  if ((rawMode === null) !== (rawUntil === null)) {
    throw new S3Error("InvalidRequest", {
      Reason: "Object lock mode and retain-until-date must be given together.",
    });
  }
  if (rawUntil !== null && Number.isNaN(Date.parse(rawUntil))) {
    throw new S3Error("InvalidArgument", {
      ArgumentName: "x-amz-object-lock-retain-until-date",
    });
  }
  if (rawHold !== null && rawHold !== "ON" && rawHold !== "OFF") {
    throw new S3Error("InvalidArgument", { ArgumentName: "x-amz-object-lock-legal-hold" });
  }

  return {
    mode: rawMode as LockMode | null,
    retainUntil: rawUntil ? new Date(rawUntil).toISOString() : null,
    legalHold: rawHold === "ON",
  };
}

/** Whether the caller asked to bypass a GOVERNANCE lock. */
export function bypassRequested(headers: Headers): boolean {
  return (headers.get("x-amz-bypass-governance-retention") ?? "").toLowerCase() === "true";
}
