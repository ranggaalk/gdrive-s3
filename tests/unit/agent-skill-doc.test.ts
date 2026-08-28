// The AI agent skill doc is handed to an agent as ground truth about what this
// gateway can do, so a stale line there is worse than a stale line in the
// README: it actively steers generated code away from working features.
//
// It went stale exactly that way once. Six capabilities shipped and reached
// `supported` in the compatibility matrix while the doc still listed them under
// "Avoid or explicitly handle" — ACLs and bucket policies, Object Lock,
// versioning, SSE-KMS, SigV4A, and cross-user copy. Nothing connected the two
// files, so nothing objected. These assertions are that connection.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { COMPAT_MATRIX } from "../../apps/server/src/compat/matrix.ts";

const skillDoc = readFileSync(
  new URL("../../apps/web/src/docs/drive-s3-ai-agent-skill.md", import.meta.url).pathname,
  "utf8",
);

/**
 * Matrix feature -> the phrase the skill doc must carry once that feature is
 * supported. Only capabilities an integrator would design differently around
 * are listed; plumbing rows like "Path-style endpoint" need no entry.
 */
const REQUIRED_MENTIONS: Record<string, string[]> = {
  "Object versioning": ["ListObjectVersions", "delete marker"],
  "Object Lock / Legal Hold": ["Object Lock", "legal hold"],
  "ACL & Bucket Policy": ["bucket polic", "x-amz-acl"],
  "SSE-KMS / Server-side encryption": ["SSE-KMS", "SSE-C", "ServerSideEncryption"],
  "SigV4A (AWS4-ECDSA-P256-SHA256)": ["SigV4A"],
  "PresignedPost (browser form POST)": ["PresignedPost"],
  "CopyObject with byte range / cross-user": ["byte-range copies"],
  "Virtual-hosted style bucket endpoint": ["S3_VIRTUAL_HOSTED_DOMAIN"],
  "Multipart Upload (Create/UploadPart/Complete/Abort/List)": ["Multipart upload"],
  "ListObjectsV2 (prefix, delimiter, continuation)": ["ListObjectsV2"],
};

describe("AI agent skill doc tracks the compatibility matrix", () => {
  test("every supported feature that needs a mention has one", () => {
    const lower = skillDoc.toLowerCase();
    const missing: string[] = [];
    for (const row of COMPAT_MATRIX) {
      if (row.status !== "supported") continue;
      for (const phrase of REQUIRED_MENTIONS[row.feature] ?? []) {
        if (!lower.includes(phrase.toLowerCase())) missing.push(`${row.feature} -> "${phrase}"`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("no required mention points at a feature the matrix no longer has", () => {
    const features = new Set(COMPAT_MATRIX.map((row) => row.feature));
    const stale = Object.keys(REQUIRED_MENTIONS).filter((key) => !features.has(key));
    expect(stale).toEqual([]);
  });

  test("the doc does not carry a blanket list of features to avoid", () => {
    // The old "Avoid or explicitly handle" list is what went stale: it named
    // whole features rather than specific behaviours, so shipping a feature
    // never prompted anyone to revisit it. Real constraints belong in
    // "Behaviour to design around", stated as behaviour.
    expect(skillDoc).not.toContain("Avoid or explicitly handle");
    expect(skillDoc).toContain("## Behaviour to design around");
  });

  test("it points at the matrix as the authority rather than restating it", () => {
    expect(skillDoc).toContain("compatibility matrix");
  });

  test("the endpoint and region placeholders the docs page substitutes are intact", () => {
    // DocsPage replaceAll()s these; a renamed placeholder would ship the
    // literal token to the user instead of their endpoint.
    expect(skillDoc).toContain("{{S3_ENDPOINT}}");
    expect(skillDoc).toContain("{{S3_REGION}}");
  });
});
