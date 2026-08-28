import { describe, expect, test } from "bun:test";
import {
  bucketArn,
  evaluatePolicy,
  objectArn,
  parseBucketPolicy,
  policyIsPublic,
  wildcardMatch,
  type PolicyContext,
  type PolicyPrincipal,
} from "../../apps/server/src/s3/policy.ts";
import { S3Error } from "../../apps/server/src/s3/errors.ts";

const ANON: PolicyPrincipal = { userId: null, email: null };
const ERIC: PolicyPrincipal = { userId: "usr_1", email: "eric@x.com" };
const MALLORY: PolicyPrincipal = { userId: "usr_2", email: "mallory@x.com" };

const PLAIN: PolicyContext = { sourceIp: "203.0.113.10", secureTransport: true };

function policy(document: unknown) {
  return parseBucketPolicy(JSON.stringify(document));
}

function decide(
  document: unknown,
  principal: PolicyPrincipal,
  action: string,
  resourceArn: string,
  context: PolicyContext = PLAIN,
) {
  return evaluatePolicy({ policy: policy(document), principal, action, resourceArn, context });
}

const PUBLIC_READ = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "PublicRead",
      Effect: "Allow",
      Principal: "*",
      Action: "s3:GetObject",
      Resource: "arn:aws:s3:::media/*",
    },
  ],
};

describe("policy parsing", () => {
  test("accepts a canonical public-read document", () => {
    const parsed = policy(PUBLIC_READ);
    expect(parsed.version).toBe("2012-10-17");
    expect(parsed.statements).toHaveLength(1);
    expect(parsed.statements[0]).toMatchObject({
      sid: "PublicRead",
      effect: "Allow",
      anyPrincipal: true,
      actions: ["s3:GetObject"],
      resources: ["arn:aws:s3:::media/*"],
    });
  });

  test("accepts a single statement object as well as an array", () => {
    const single = policy({ Statement: { Effect: "Allow", Principal: "*", Action: "s3:*", Resource: "*" } });
    expect(single.statements).toHaveLength(1);
  });

  test("accepts the { AWS: ... } principal forms", () => {
    expect(policy({ Statement: [{ Effect: "Allow", Principal: { AWS: "*" }, Action: "s3:*", Resource: "*" }] })
      .statements[0]!.anyPrincipal).toBe(true);
    expect(policy({
      Statement: [{
        Effect: "Allow",
        Principal: { AWS: ["arn:aws:iam:::user/eric@x.com"] },
        Action: "s3:*",
        Resource: "*",
      }],
    }).statements[0]!.principalEmails).toEqual(["eric@x.com"]);
  });

  test("rejects malformed documents", () => {
    const bad: unknown[] = [
      { Statement: [{ Effect: "Maybe", Principal: "*", Action: "s3:*", Resource: "*" }] },
      { Statement: [{ Effect: "Allow", Action: "s3:*", Resource: "*" }] }, // no principal
      { Statement: [{ Effect: "Allow", Principal: "*", Resource: "*" }] }, // no action
      { Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:*" }] }, // no resource
      { Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:*", NotAction: "s3:Get*", Resource: "*" }] },
      { Statement: [{ Effect: "Allow", Principal: "*", NotPrincipal: "*", Action: "s3:*", Resource: "*" }] },
      { Statement: [{ Effect: "Allow", Principal: { AWS: "not-an-arn" }, Action: "s3:*", Resource: "*" }] },
      { Statement: [{ Effect: "Allow", Principal: "*", Action: 5, Resource: "*" }] },
      { Statement: [] },
      { Version: "2012-10-17" }, // no Statement
      [],
    ];
    for (const document of bad) {
      expect(() => policy(document)).toThrow(S3Error);
    }
  });

  test("rejects non-JSON, oversized, and over-long documents", () => {
    expect(() => parseBucketPolicy("not json")).toThrow(S3Error);
    expect(() => parseBucketPolicy(JSON.stringify({ Statement: [{
      Effect: "Allow", Principal: "*", Action: "s3:*", Resource: "x".repeat(25_000),
    }] }))).toThrow(S3Error);
    const many = Array.from({ length: 65 }, () => ({
      Effect: "Allow", Principal: "*", Action: "s3:*", Resource: "*",
    }));
    expect(() => policy({ Statement: many })).toThrow(S3Error);
  });

  test("rejects an unsupported condition operator", () => {
    expect(() => policy({
      Statement: [{
        Effect: "Allow", Principal: "*", Action: "s3:*", Resource: "*",
        Condition: { DateGreaterThan: { "aws:CurrentTime": "2020-01-01" } },
      }],
    })).toThrow(S3Error);
  });
});

describe("wildcard matching", () => {
  test("* spans any run and ? exactly one character", () => {
    expect(wildcardMatch("*", "anything")).toBe(true);
    expect(wildcardMatch("s3:Get*", "s3:GetObject")).toBe(true);
    expect(wildcardMatch("s3:Get*", "s3:PutObject")).toBe(false);
    expect(wildcardMatch("a?c", "abc")).toBe(true);
    expect(wildcardMatch("a?c", "ac")).toBe(false);
    expect(wildcardMatch("arn:aws:s3:::media/*", "arn:aws:s3:::media/a/b.png")).toBe(true);
  });

  test("treats regex metacharacters as literals", () => {
    expect(wildcardMatch("a.c", "abc")).toBe(false);
    expect(wildcardMatch("a.c", "a.c")).toBe(true);
    expect(wildcardMatch("a+", "aaa")).toBe(false);
    expect(wildcardMatch("(x)", "(x)")).toBe(true);
    expect(wildcardMatch("a|b", "a")).toBe(false);
  });

  test("anchors the whole value", () => {
    expect(wildcardMatch("arn:aws:s3:::media", "arn:aws:s3:::media-other")).toBe(false);
    expect(wildcardMatch("s3:GetObject", "xs3:GetObject")).toBe(false);
  });
});

describe("policy evaluation", () => {
  test("allows an anonymous GET on a public-read bucket", () => {
    expect(decide(PUBLIC_READ, ANON, "s3:GetObject", objectArn("media", "logo.png"))).toBe("allow");
  });

  test("says nothing about actions the policy does not cover", () => {
    expect(decide(PUBLIC_READ, ANON, "s3:PutObject", objectArn("media", "logo.png"))).toBe("none");
    expect(decide(PUBLIC_READ, ANON, "s3:GetObject", objectArn("other", "logo.png"))).toBe("none");
  });

  test("an explicit Deny beats an Allow regardless of order", () => {
    const denyFirst = {
      Statement: [
        { Effect: "Deny", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::media/secret/*" },
        { Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::media/*" },
      ],
    };
    const allowFirst = { Statement: [...denyFirst.Statement].reverse() };
    const secret = objectArn("media", "secret/keys.txt");
    expect(decide(denyFirst, ANON, "s3:GetObject", secret)).toBe("deny");
    expect(decide(allowFirst, ANON, "s3:GetObject", secret)).toBe("deny");
    // A key outside the denied prefix is still allowed.
    expect(decide(allowFirst, ANON, "s3:GetObject", objectArn("media", "public.png"))).toBe("allow");
  });

  test("matches a named user principal and no one else", () => {
    const document = {
      Statement: [{
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam:::user/eric@x.com" },
        Action: "s3:GetObject",
        Resource: "arn:aws:s3:::media/*",
      }],
    };
    const key = objectArn("media", "a.png");
    expect(decide(document, ERIC, "s3:GetObject", key)).toBe("allow");
    expect(decide(document, MALLORY, "s3:GetObject", key)).toBe("none");
    expect(decide(document, ANON, "s3:GetObject", key)).toBe("none");
  });

  test("principal matching is case-insensitive on the email", () => {
    const document = {
      Statement: [{
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam:::user/Eric@X.com" },
        Action: "s3:*",
        Resource: "*",
      }],
    };
    expect(decide(document, ERIC, "s3:GetObject", objectArn("m", "k"))).toBe("allow");
  });

  test("NotPrincipal inverts the match", () => {
    const document = {
      Statement: [{
        Effect: "Deny",
        NotPrincipal: { AWS: "arn:aws:iam:::user/eric@x.com" },
        Action: "s3:GetObject",
        Resource: "arn:aws:s3:::media/*",
      }],
    };
    const key = objectArn("media", "a.png");
    expect(decide(document, ERIC, "s3:GetObject", key)).toBe("none");
    expect(decide(document, MALLORY, "s3:GetObject", key)).toBe("deny");
    expect(decide(document, ANON, "s3:GetObject", key)).toBe("deny");
  });

  test("NotAction and NotResource invert their matches", () => {
    const notAction = {
      Statement: [{
        Effect: "Deny", Principal: "*", NotAction: "s3:GetObject", Resource: "*",
      }],
    };
    expect(decide(notAction, ANON, "s3:GetObject", objectArn("m", "k"))).toBe("none");
    expect(decide(notAction, ANON, "s3:DeleteObject", objectArn("m", "k"))).toBe("deny");

    const notResource = {
      Statement: [{
        Effect: "Allow", Principal: "*", Action: "s3:GetObject", NotResource: "arn:aws:s3:::media/private/*",
      }],
    };
    expect(decide(notResource, ANON, "s3:GetObject", objectArn("media", "public.png"))).toBe("allow");
    expect(decide(notResource, ANON, "s3:GetObject", objectArn("media", "private/x"))).toBe("none");
  });

  test("bucket-level actions match the bucket ARN, not the object ARN", () => {
    const document = {
      Statement: [{
        Effect: "Allow", Principal: "*", Action: "s3:ListBucket", Resource: "arn:aws:s3:::media",
      }],
    };
    expect(decide(document, ANON, "s3:ListBucket", bucketArn("media"))).toBe("allow");
    expect(decide(document, ANON, "s3:ListBucket", objectArn("media", "k"))).toBe("none");
  });

  test("wildcard actions cover the catalogue", () => {
    const document = { Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:*", Resource: "*" }] };
    for (const action of ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]) {
      expect(decide(document, ANON, action, objectArn("m", "k"))).toBe("allow");
    }
  });
});

describe("policy conditions", () => {
  const ipLocked = {
    Statement: [{
      Effect: "Allow",
      Principal: "*",
      Action: "s3:GetObject",
      Resource: "arn:aws:s3:::media/*",
      Condition: { IpAddress: { "aws:SourceIp": ["203.0.113.0/24"] } },
    }],
  };

  test("IpAddress admits inside the range and withholds outside it", () => {
    const key = objectArn("media", "a.png");
    expect(decide(ipLocked, ANON, "s3:GetObject", key, { sourceIp: "203.0.113.55", secureTransport: true })).toBe("allow");
    expect(decide(ipLocked, ANON, "s3:GetObject", key, { sourceIp: "198.51.100.1", secureTransport: true })).toBe("none");
  });

  test("a condition on a missing value cannot be satisfied", () => {
    expect(decide(ipLocked, ANON, "s3:GetObject", objectArn("media", "a.png"), {
      sourceIp: null,
      secureTransport: true,
    })).toBe("none");
  });

  test("NotIpAddress passes when there is no address to test", () => {
    const document = {
      Statement: [{
        Effect: "Deny", Principal: "*", Action: "s3:GetObject", Resource: "*",
        Condition: { NotIpAddress: { "aws:SourceIp": "203.0.113.0/24" } },
      }],
    };
    expect(decide(document, ANON, "s3:GetObject", objectArn("m", "k"), {
      sourceIp: null, secureTransport: true,
    })).toBe("deny");
    expect(decide(document, ANON, "s3:GetObject", objectArn("m", "k"), {
      sourceIp: "203.0.113.9", secureTransport: true,
    })).toBe("none");
  });

  test("exact /32 and full-range /0 CIDRs behave", () => {
    const exact = {
      Statement: [{
        Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "*",
        Condition: { IpAddress: { "aws:SourceIp": "203.0.113.10/32" } },
      }],
    };
    expect(decide(exact, ANON, "s3:GetObject", objectArn("m", "k"), { sourceIp: "203.0.113.10", secureTransport: true })).toBe("allow");
    expect(decide(exact, ANON, "s3:GetObject", objectArn("m", "k"), { sourceIp: "203.0.113.11", secureTransport: true })).toBe("none");
  });

  test("a malformed CIDR never matches", () => {
    const document = {
      Statement: [{
        Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "*",
        Condition: { IpAddress: { "aws:SourceIp": "not-an-ip/24" } },
      }],
    };
    expect(decide(document, ANON, "s3:GetObject", objectArn("m", "k"))).toBe("none");
  });

  test("Bool on aws:SecureTransport gates plaintext requests", () => {
    const document = {
      Statement: [{
        Effect: "Deny", Principal: "*", Action: "s3:*", Resource: "*",
        Condition: { Bool: { "aws:SecureTransport": "false" } },
      }],
    };
    expect(decide(document, ANON, "s3:GetObject", objectArn("m", "k"), { sourceIp: null, secureTransport: false })).toBe("deny");
    expect(decide(document, ANON, "s3:GetObject", objectArn("m", "k"), { sourceIp: null, secureTransport: true })).toBe("none");
  });

  test("StringEquals on aws:username scopes to one caller", () => {
    const document = {
      Statement: [{
        Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "*",
        Condition: { StringEquals: { "aws:username": "eric@x.com" } },
      }],
    };
    expect(decide(document, ERIC, "s3:GetObject", objectArn("m", "k"))).toBe("allow");
    expect(decide(document, MALLORY, "s3:GetObject", objectArn("m", "k"))).toBe("none");
    expect(decide(document, ANON, "s3:GetObject", objectArn("m", "k"))).toBe("none");
  });

  test("every condition in a statement must hold", () => {
    const document = {
      Statement: [{
        Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "*",
        Condition: {
          IpAddress: { "aws:SourceIp": "203.0.113.0/24" },
          Bool: { "aws:SecureTransport": "true" },
        },
      }],
    };
    expect(decide(document, ANON, "s3:GetObject", objectArn("m", "k"), { sourceIp: "203.0.113.5", secureTransport: true })).toBe("allow");
    // Right IP, wrong transport.
    expect(decide(document, ANON, "s3:GetObject", objectArn("m", "k"), { sourceIp: "203.0.113.5", secureTransport: false })).toBe("none");
  });
});

describe("policyIsPublic", () => {
  test("is true when anyone is allowed anything", () => {
    expect(policyIsPublic(policy(PUBLIC_READ))).toBe(true);
  });

  test("is false for a policy that only names users", () => {
    expect(policyIsPublic(policy({
      Statement: [{
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam:::user/eric@x.com" },
        Action: "s3:GetObject",
        Resource: "*",
      }],
    }))).toBe(false);
  });

  test("is false when the only wildcard statement is a Deny", () => {
    expect(policyIsPublic(policy({
      Statement: [{ Effect: "Deny", Principal: "*", Action: "s3:*", Resource: "*" }],
    }))).toBe(false);
  });
});
