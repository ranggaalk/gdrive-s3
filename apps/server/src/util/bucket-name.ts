// Conservative S3 bucket-name validation (AGENTS.md §9).
// 3-63 chars, lowercase letters/digits/dot/hyphen, start & end alphanumeric,
// no IPv4-like names, no consecutive dots, no ".-" or "-." adjacency.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// Top-level dashboard route segments (routes/dashboard.ts) — a bucket with
// one of these names would be unreachable via plain browser navigation.
const RESERVED_NAMES = new Set([
  "overview",
  "buckets",
  "credentials",
  "activity",
  "documentation",
  "backup",
  "quota",
  "settings",
  "security",
]);

export function isValidBucketName(name: string): boolean {
  if (name.length < 3 || name.length > 63) return false;
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name)) return false;
  if (name.includes("..")) return false;
  if (name.includes(".-") || name.includes("-.")) return false;
  if (IPV4.test(name)) return false;
  if (RESERVED_NAMES.has(name)) return false;
  return true;
}

/** Throws with an S3-style reason if invalid; otherwise returns the name. */
export function assertValidBucketName(name: string): string {
  if (!isValidBucketName(name)) {
    throw new InvalidBucketNameError(name);
  }
  return name;
}

export class InvalidBucketNameError extends Error {
  public readonly bucketName: string;
  constructor(bucketName: string) {
    super("The specified bucket is not valid.");
    this.name = "InvalidBucketNameError";
    this.bucketName = bucketName;
  }
}
