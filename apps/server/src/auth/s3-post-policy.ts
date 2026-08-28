// POST policy verification for browser form uploads (PresignedPost).
//
// Unlike every other S3 authentication path, a POST policy does not sign a
// canonical request. The client signs the base64 policy document verbatim with
// an ordinary SigV4 signing key, and the policy itself constrains which form
// fields the browser is allowed to submit. So the policy *is* the authorization
// decision, and it has to be evaluated in full: a condition that is skipped is
// a restriction the uploader escapes.
//
// Kept free of I/O so it can be unit-tested on its own.

import { timingSafeEqual } from "node:crypto";
import { computeSignature, deriveSigningKey } from "./sigv4-canonical.ts";

export const POST_ALGORITHM = "AWS4-HMAC-SHA256";

/** Generous next to a realistic policy (a few hundred bytes) and far below
 *  anything that would make JSON parsing a denial-of-service vector. */
export const MAX_POLICY_BYTES = 20_000;
export const MAX_POLICY_CONDITIONS = 64;

/**
 * Form fields that never need a matching policy condition. Everything else the
 * browser submits must be covered by one, per the S3 POST policy rules — this
 * is what stops a form from smuggling in an unconstrained header.
 */
const UNCONSTRAINED_FIELDS = new Set(["policy", "x-amz-signature", "file"]);
const UNCONSTRAINED_PREFIX = "x-ignore-";

export type PostCondition =
  | { kind: "eq"; field: string; value: string }
  | { kind: "starts-with"; field: string; prefix: string }
  | { kind: "content-length-range"; min: number; max: number };

export interface ParsedPostPolicy {
  expiresAtMs: number;
  conditions: PostCondition[];
}

export class PostPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostPolicyError";
  }
}

function normalizeField(raw: string): string {
  return raw.toLowerCase();
}

/** Condition field names are written as `$field` in the array form. */
function stripDollar(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("$")) {
    throw new PostPolicyError("Policy condition field must be written as $field");
  }
  const name = raw.slice(1);
  if (!name) throw new PostPolicyError("Policy condition field is empty");
  return normalizeField(name);
}

function parseCondition(raw: unknown): PostCondition {
  // Object form: { "acl": "public-read" } — an exact match.
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length !== 1) {
      throw new PostPolicyError("Policy condition object must hold exactly one field");
    }
    const [field, value] = entries[0]!;
    if (typeof value !== "string") {
      throw new PostPolicyError(`Policy condition for ${field} must be a string`);
    }
    return { kind: "eq", field: normalizeField(field), value };
  }

  if (!Array.isArray(raw)) throw new PostPolicyError("Unrecognised policy condition");

  const operator = raw[0];
  if (typeof operator !== "string") throw new PostPolicyError("Policy condition operator missing");

  switch (operator.toLowerCase()) {
    case "eq": {
      if (raw.length !== 3 || typeof raw[2] !== "string") {
        throw new PostPolicyError("eq condition takes a field and a value");
      }
      return { kind: "eq", field: stripDollar(raw[1]), value: raw[2] };
    }
    case "starts-with": {
      if (raw.length !== 3 || typeof raw[2] !== "string") {
        throw new PostPolicyError("starts-with condition takes a field and a prefix");
      }
      return { kind: "starts-with", field: stripDollar(raw[1]), prefix: raw[2] };
    }
    case "content-length-range": {
      if (raw.length !== 3) {
        throw new PostPolicyError("content-length-range takes a minimum and a maximum");
      }
      const min = Number(raw[1]);
      const max = Number(raw[2]);
      if (
        !Number.isSafeInteger(min) ||
        !Number.isSafeInteger(max) ||
        min < 0 ||
        max < min
      ) {
        throw new PostPolicyError("content-length-range bounds are not a valid range");
      }
      return { kind: "content-length-range", min, max };
    }
    default:
      throw new PostPolicyError(`Unsupported policy condition operator: ${operator}`);
  }
}

/** Decode and validate the base64 policy document a form submitted. */
export function parsePostPolicy(policyBase64: string): ParsedPostPolicy {
  if (policyBase64.length > MAX_POLICY_BYTES) {
    throw new PostPolicyError("Policy document is too large");
  }
  let json: string;
  try {
    json = Buffer.from(policyBase64, "base64").toString("utf8");
  } catch {
    throw new PostPolicyError("Policy document is not valid base64");
  }
  if (Buffer.byteLength(json) > MAX_POLICY_BYTES) {
    throw new PostPolicyError("Policy document is too large");
  }

  let document: unknown;
  try {
    document = JSON.parse(json);
  } catch {
    throw new PostPolicyError("Policy document is not valid JSON");
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new PostPolicyError("Policy document must be a JSON object");
  }

  const { expiration, conditions } = document as { expiration?: unknown; conditions?: unknown };
  if (typeof expiration !== "string") {
    throw new PostPolicyError("Policy document is missing an expiration");
  }
  const expiresAtMs = Date.parse(expiration);
  if (Number.isNaN(expiresAtMs)) {
    throw new PostPolicyError("Policy expiration is not a valid timestamp");
  }
  if (!Array.isArray(conditions)) {
    throw new PostPolicyError("Policy document is missing its conditions");
  }
  if (conditions.length > MAX_POLICY_CONDITIONS) {
    throw new PostPolicyError("Policy document has too many conditions");
  }

  return { expiresAtMs, conditions: conditions.map(parseCondition) };
}

export interface PostPolicyCheckInput {
  policy: ParsedPostPolicy;
  /**
   * Everything a condition may match, keyed by lowercased field name. This
   * includes values that are not form fields at all — `bucket` comes from the
   * request path, and a policy is required to pin it.
   */
  fields: Map<string, string>;
  /** Only the names the browser actually submitted, for the coverage check. */
  submittedFields: Iterable<string>;
  now?: number;
}

/**
 * Check the submitted fields against the policy. Returns null when the upload
 * is allowed, or a human-readable reason when it is not.
 *
 * Note the two directions: every condition must be satisfied by a field, *and*
 * every field must be covered by a condition. Only enforcing the first would
 * let a form add fields the policy signer never agreed to.
 */
export function checkPostPolicy(input: PostPolicyCheckInput): string | null {
  const now = input.now ?? Date.now();
  if (now > input.policy.expiresAtMs) return "Policy has expired";

  const covered = new Set<string>();

  for (const condition of input.policy.conditions) {
    if (condition.kind === "content-length-range") continue; // checked against the body
    const actual = input.fields.get(condition.field);
    if (actual === undefined) {
      return `Policy requires a value for ${condition.field}`;
    }
    if (condition.kind === "eq" && actual !== condition.value) {
      return `Value for ${condition.field} does not match the policy`;
    }
    if (condition.kind === "starts-with" && !actual.startsWith(condition.prefix)) {
      return `Value for ${condition.field} does not match the policy`;
    }
    covered.add(condition.field);
  }

  for (const field of input.submittedFields) {
    if (UNCONSTRAINED_FIELDS.has(field)) continue;
    if (field.startsWith(UNCONSTRAINED_PREFIX)) continue;
    if (!covered.has(field)) return `Field ${field} is not allowed by the policy`;
  }

  return null;
}

/** The content-length-range bounds, or null when the policy sets none. */
export function contentLengthRange(
  policy: ParsedPostPolicy,
): { min: number; max: number } | null {
  for (const condition of policy.conditions) {
    if (condition.kind === "content-length-range") {
      return { min: condition.min, max: condition.max };
    }
  }
  return null;
}

export interface PostCredential {
  accessKeyId: string;
  dateStamp: string;
  region: string;
  service: string;
}

/** `<access-key-id>/<date>/<region>/s3/aws4_request` */
export function parsePostCredential(raw: string): PostCredential | null {
  const parts = raw.split("/");
  if (parts.length !== 5) return null;
  const [accessKeyId, dateStamp, region, service, terminator] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (terminator !== "aws4_request") return null;
  if (!accessKeyId || !dateStamp || !region || !service) return null;
  return { accessKeyId, dateStamp, region, service };
}

/**
 * Verify the form signature. The string-to-sign is the base64 policy exactly as
 * it arrived — re-encoding it here would change the bytes and break valid
 * uploads, so the raw field value is what gets signed.
 */
export function verifyPostSignature(input: {
  secretAccessKey: string;
  credential: PostCredential;
  policyBase64: string;
  signature: string;
}): boolean {
  if (!/^[0-9a-f]{64}$/.test(input.signature)) return false;
  const signingKey = deriveSigningKey(
    input.secretAccessKey,
    input.credential.dateStamp,
    input.credential.region,
    input.credential.service,
  );
  try {
    const expected = computeSignature(signingKey, input.policyBase64);
    const a = Buffer.from(input.signature, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  } finally {
    signingKey.fill(0);
  }
}
