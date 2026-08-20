import { describe, expect, test } from "bun:test";
import { isValidBucketName } from "../../apps/server/src/util/bucket-name.ts";

describe("isValidBucketName", () => {
  const valid = ["docs", "my-bucket", "a.b.c", "bucket123", "abc", "a".repeat(63)];
  const invalid = [
    "ab", // too short
    "a".repeat(64), // too long
    "Docs", // uppercase
    "-bucket", // leading hyphen
    "bucket-", // trailing hyphen
    ".bucket", // leading dot
    "bucket.", // trailing dot
    "a..b", // consecutive dots
    "a.-b", // dot-hyphen
    "a-.b", // hyphen-dot
    "192.168.0.1", // IPv4-like
    "bucket_name", // underscore
    "bucket name", // space
  ];

  for (const name of valid) {
    test(`valid: ${name}`, () => expect(isValidBucketName(name)).toBe(true));
  }
  for (const name of invalid) {
    test(`invalid: ${name}`, () => expect(isValidBucketName(name)).toBe(false));
  }
});
