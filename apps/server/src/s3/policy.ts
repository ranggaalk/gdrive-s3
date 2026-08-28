// Bucket policy documents: parsing, validation, and evaluation.
//
// The evaluator follows the IAM rule that matters most: an explicit Deny beats
// everything. A statement that matches with Effect "Deny" wins outright, no
// matter how many Allows also match. Absent any match the result is "none",
// which the caller resolves against ownership and ACL.
//
// Kept free of I/O so it can be unit-tested on its own.

import { S3Error } from "./errors.ts";

/** Generous next to a realistic policy and far below anything that would make
 *  JSON parsing a denial-of-service vector. S3's own limit is 20 KB. */
export const MAX_POLICY_BYTES = 20_480;
export const MAX_STATEMENTS = 64;
/** Guards against a single statement carrying an unbounded action/resource list. */
export const MAX_LIST_ENTRIES = 128;

/**
 * Actions this gateway understands. A policy may name others — S3 accepts the
 * full catalogue — but only these ever get evaluated, so an unknown action can
 * never widen access beyond what the data plane implements.
 */
export const KNOWN_ACTIONS = [
  "s3:GetObject",
  "s3:PutObject",
  "s3:DeleteObject",
  "s3:ListBucket",
  "s3:GetBucketLocation",
  "s3:GetBucketPolicy",
  "s3:PutBucketPolicy",
  "s3:GetBucketAcl",
  "s3:PutBucketAcl",
  "s3:GetObjectAcl",
  "s3:PutObjectAcl",
  "s3:AbortMultipartUpload",
  "s3:ListMultipartUploadParts",
] as const;

export type PolicyAction = (typeof KNOWN_ACTIONS)[number];

export type PolicyEffect = "Allow" | "Deny";
export type PolicyDecision = "allow" | "deny" | "none";

export interface PolicyPrincipal {
  /** Null for an unauthenticated caller. */
  userId: string | null;
  /** The email a policy names in `arn:aws:iam:::user/<email>`. */
  email: string | null;
}

export interface PolicyContext {
  sourceIp: string | null;
  secureTransport: boolean;
}

interface Condition {
  operator: string;
  key: string;
  values: string[];
}

export interface PolicyStatement {
  sid: string | null;
  effect: PolicyEffect;
  /** Empty means "*" was given — matches every principal, anonymous included. */
  anyPrincipal: boolean;
  principalEmails: string[];
  /** True when the statement uses NotPrincipal instead of Principal. */
  negatedPrincipal: boolean;
  actions: string[];
  notActions: string[];
  resources: string[];
  notResources: string[];
  conditions: Condition[];
}

export interface BucketPolicy {
  version: string | null;
  id: string | null;
  statements: PolicyStatement[];
}

function malformed(reason: string): never {
  throw new S3Error("MalformedPolicy", { Reason: reason });
}

/** Accept a bare string or an array of strings, as every IAM field allows. */
function stringList(raw: unknown, field: string): string[] {
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) {
    if (raw.length > MAX_LIST_ENTRIES) malformed(`${field} has too many entries`);
    return raw.map((entry) => {
      if (typeof entry !== "string") malformed(`${field} must contain only strings`);
      return entry;
    });
  }
  malformed(`${field} must be a string or an array of strings`);
}

const USER_ARN_PREFIX = "arn:aws:iam:::user/";

function parsePrincipal(
  raw: unknown,
  field: string,
): { anyPrincipal: boolean; emails: string[] } {
  if (raw === "*") return { anyPrincipal: true, emails: [] };
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const aws = (raw as Record<string, unknown>)["AWS"];
    if (aws === undefined) malformed(`${field} must name an AWS principal`);
    if (aws === "*") return { anyPrincipal: true, emails: [] };
    const entries = stringList(aws, `${field}.AWS`);
    if (entries.includes("*")) return { anyPrincipal: true, emails: [] };
    const emails = entries.map((entry) => {
      if (!entry.startsWith(USER_ARN_PREFIX)) {
        malformed(`${field} entries must be "*" or ${USER_ARN_PREFIX}<email>`);
      }
      const email = entry.slice(USER_ARN_PREFIX.length).toLowerCase();
      if (!email) malformed(`${field} names an empty user`);
      return email;
    });
    return { anyPrincipal: false, emails };
  }
  malformed(`${field} must be "*" or an object naming an AWS principal`);
}

const SUPPORTED_OPERATORS = new Set([
  "StringEquals",
  "StringNotEquals",
  "StringLike",
  "StringNotLike",
  "IpAddress",
  "NotIpAddress",
  "Bool",
]);

function parseConditions(raw: unknown): Condition[] {
  if (raw === undefined) return [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    malformed("Condition must be an object");
  }
  const conditions: Condition[] = [];
  for (const [operator, block] of Object.entries(raw as Record<string, unknown>)) {
    if (!SUPPORTED_OPERATORS.has(operator)) {
      malformed(`Unsupported condition operator: ${operator}`);
    }
    if (block === null || typeof block !== "object" || Array.isArray(block)) {
      malformed(`Condition ${operator} must be an object`);
    }
    for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
      conditions.push({
        operator,
        key: key.toLowerCase(),
        values: stringList(value, `Condition ${operator} ${key}`),
      });
    }
  }
  return conditions;
}

function parseStatement(raw: unknown, index: number): PolicyStatement {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    malformed(`Statement ${index} must be an object`);
  }
  const statement = raw as Record<string, unknown>;

  const effect = statement["Effect"];
  if (effect !== "Allow" && effect !== "Deny") {
    malformed(`Statement ${index} must have Effect "Allow" or "Deny"`);
  }

  const hasPrincipal = statement["Principal"] !== undefined;
  const hasNotPrincipal = statement["NotPrincipal"] !== undefined;
  if (hasPrincipal && hasNotPrincipal) {
    malformed(`Statement ${index} cannot set both Principal and NotPrincipal`);
  }
  // A resource-based policy must say who it applies to.
  if (!hasPrincipal && !hasNotPrincipal) {
    malformed(`Statement ${index} must name a Principal`);
  }
  const principal = parsePrincipal(
    hasPrincipal ? statement["Principal"] : statement["NotPrincipal"],
    hasPrincipal ? "Principal" : "NotPrincipal",
  );

  const hasAction = statement["Action"] !== undefined;
  const hasNotAction = statement["NotAction"] !== undefined;
  if (hasAction && hasNotAction) {
    malformed(`Statement ${index} cannot set both Action and NotAction`);
  }
  if (!hasAction && !hasNotAction) malformed(`Statement ${index} must name an Action`);

  const hasResource = statement["Resource"] !== undefined;
  const hasNotResource = statement["NotResource"] !== undefined;
  if (hasResource && hasNotResource) {
    malformed(`Statement ${index} cannot set both Resource and NotResource`);
  }
  if (!hasResource && !hasNotResource) malformed(`Statement ${index} must name a Resource`);

  const sid = statement["Sid"];
  if (sid !== undefined && typeof sid !== "string") {
    malformed(`Statement ${index} Sid must be a string`);
  }

  return {
    sid: sid ?? null,
    effect,
    anyPrincipal: principal.anyPrincipal,
    principalEmails: principal.emails,
    negatedPrincipal: hasNotPrincipal,
    actions: hasAction ? stringList(statement["Action"], "Action") : [],
    notActions: hasNotAction ? stringList(statement["NotAction"], "NotAction") : [],
    resources: hasResource ? stringList(statement["Resource"], "Resource") : [],
    notResources: hasNotResource ? stringList(statement["NotResource"], "NotResource") : [],
    conditions: parseConditions(statement["Condition"]),
  };
}

export function parseBucketPolicy(raw: string): BucketPolicy {
  if (Buffer.byteLength(raw) > MAX_POLICY_BYTES) malformed("Policy document is too large");

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    malformed("Policy document is not valid JSON");
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    malformed("Policy document must be a JSON object");
  }

  const { Version, Id, Statement } = document as Record<string, unknown>;
  if (Version !== undefined && typeof Version !== "string") {
    malformed("Version must be a string");
  }
  if (Id !== undefined && typeof Id !== "string") malformed("Id must be a string");

  const rawStatements = Array.isArray(Statement) ? Statement : [Statement];
  if (Statement === undefined) malformed("Policy document is missing Statement");
  if (rawStatements.length === 0) malformed("Policy must hold at least one statement");
  if (rawStatements.length > MAX_STATEMENTS) malformed("Policy has too many statements");

  return {
    version: Version ?? null,
    id: Id ?? null,
    statements: rawStatements.map(parseStatement),
  };
}

/**
 * IAM wildcard matching: `*` spans any run of characters, `?` exactly one.
 * Everything else is literal, so a policy resource cannot be turned into a
 * regex injection.
 */
export function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const expression = escaped.replaceAll("*", "[\\s\\S]*").replaceAll("?", "[\\s\\S]");
  return new RegExp(`^${expression}$`).test(value);
}

export function bucketArn(bucketName: string): string {
  return `arn:aws:s3:::${bucketName}`;
}

export function objectArn(bucketName: string, key: string): string {
  return `arn:aws:s3:::${bucketName}/${key}`;
}

function matchesAction(statement: PolicyStatement, action: string): boolean {
  const matches = (patterns: string[]) =>
    patterns.some((pattern) => wildcardMatch(pattern, action));
  if (statement.notActions.length > 0) return !matches(statement.notActions);
  return matches(statement.actions);
}

function matchesResource(statement: PolicyStatement, resourceArn: string): boolean {
  const matches = (patterns: string[]) =>
    patterns.some((pattern) => wildcardMatch(pattern, resourceArn));
  if (statement.notResources.length > 0) return !matches(statement.notResources);
  return matches(statement.resources);
}

function matchesPrincipal(statement: PolicyStatement, principal: PolicyPrincipal): boolean {
  const named =
    statement.anyPrincipal ||
    (principal.email !== null &&
      statement.principalEmails.includes(principal.email.toLowerCase()));
  return statement.negatedPrincipal ? !named : named;
}

/** IPv4 CIDR containment. A malformed range never matches rather than throwing. */
function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split("/");
  if (!range) return false;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const toInt = (value: string): number | null => {
    const parts = value.split(".");
    if (parts.length !== 4) return null;
    let out = 0;
    for (const part of parts) {
      if (!/^\d{1,3}$/.test(part)) return null;
      const octet = Number(part);
      if (octet > 255) return null;
      out = (out << 8) | octet;
    }
    return out >>> 0;
  };

  const ipInt = toInt(ip);
  const rangeInt = toInt(range);
  if (ipInt === null || rangeInt === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function conditionValue(
  key: string,
  principal: PolicyPrincipal,
  context: PolicyContext,
): string | null {
  switch (key) {
    case "aws:sourceip":
      return context.sourceIp;
    case "aws:securetransport":
      return context.secureTransport ? "true" : "false";
    case "aws:username":
      return principal.email;
    case "aws:principaltype":
      return principal.userId ? "User" : "Anonymous";
    default:
      return null;
  }
}

function matchesConditions(
  statement: PolicyStatement,
  principal: PolicyPrincipal,
  context: PolicyContext,
): boolean {
  for (const condition of statement.conditions) {
    const actual = conditionValue(condition.key, principal, context);
    // An unknown or unavailable key cannot be satisfied. For a negated
    // operator that is *why* it passes: "not in this IP range" holds when
    // there is no IP to test.
    const negated =
      condition.operator === "StringNotEquals" ||
      condition.operator === "StringNotLike" ||
      condition.operator === "NotIpAddress";
    if (actual === null) {
      if (negated) continue;
      return false;
    }

    let matched: boolean;
    switch (condition.operator) {
      case "StringEquals":
      case "StringNotEquals":
        matched = condition.values.includes(actual);
        break;
      case "StringLike":
      case "StringNotLike":
        matched = condition.values.some((value) => wildcardMatch(value, actual));
        break;
      case "IpAddress":
      case "NotIpAddress":
        matched = condition.values.some((value) => ipInCidr(actual, value));
        break;
      case "Bool":
        matched = condition.values.some((value) => value.toLowerCase() === actual);
        break;
      default:
        return false;
    }
    if (negated ? matched : !matched) return false;
  }
  return true;
}

export interface EvaluateInput {
  policy: BucketPolicy;
  principal: PolicyPrincipal;
  action: string;
  resourceArn: string;
  context: PolicyContext;
}

/**
 * Evaluate a policy. Explicit Deny wins over any Allow, and "none" means the
 * policy simply had nothing to say — the caller falls back to ownership/ACL.
 */
export function evaluatePolicy(input: EvaluateInput): PolicyDecision {
  let allowed = false;
  for (const statement of input.policy.statements) {
    if (!matchesPrincipal(statement, input.principal)) continue;
    if (!matchesAction(statement, input.action)) continue;
    if (!matchesResource(statement, input.resourceArn)) continue;
    if (!matchesConditions(statement, input.principal, input.context)) continue;
    if (statement.effect === "Deny") return "deny";
    allowed = true;
  }
  return allowed ? "allow" : "none";
}

/** Whether a policy grants anything to the anonymous public — drives
 *  GetBucketPolicyStatus and the "public" badge in the dashboard. */
export function policyIsPublic(policy: BucketPolicy): boolean {
  return policy.statements.some(
    (statement) =>
      statement.effect === "Allow" && statement.anyPrincipal && !statement.negatedPrincipal,
  );
}
