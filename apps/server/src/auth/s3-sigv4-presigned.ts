// AWS SigV4 presigned-URL (query) verifier for the S3 data plane
// (AGENTS.md §11, §29 Milestone 6). Payload is treated as UNSIGNED-PAYLOAD and
// X-Amz-Signature is excluded from the canonical query.

import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config.ts";
import { S3CredentialsRepository } from "../db/repositories/s3-credentials.ts";
import type { CredentialRow } from "../db/repositories/s3-credentials.ts";
import { openFromString, aad } from "../security/encryption.ts";
import {
  UNSIGNED_PAYLOAD,
  buildCanonicalRequest,
  buildStringToSign,
  computeSignature,
  deriveSigningKey,
} from "./sigv4-canonical.ts";
import type { SigV4Result, SigV4Failure } from "./s3-sigv4.ts";

interface ParsedPresign {
  accessKeyId: string;
  dateStamp: string;
  region: string;
  service: string;
  amzDate: string;
  expiresSeconds: number;
  signedHeaders: string[];
  signature: string;
}

function parsePresigned(query: URLSearchParams): ParsedPresign | null {
  const algorithm = query.get("X-Amz-Algorithm");
  if (algorithm !== "AWS4-HMAC-SHA256") return null;
  const credential = query.get("X-Amz-Credential");
  const amzDate = query.get("X-Amz-Date");
  const expiresRaw = query.get("X-Amz-Expires");
  const signedHeaders = query.get("X-Amz-SignedHeaders");
  const signature = query.get("X-Amz-Signature");
  if (!credential || !amzDate || !expiresRaw || !signedHeaders || !signature) return null;

  const parts = credential.split("/");
  if (parts.length !== 5) return null;
  const [accessKeyId, dateStamp, region, service, terminator] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (terminator !== "aws4_request") return null;
  const expiresSeconds = Number(expiresRaw);
  if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1) return null;

  return {
    accessKeyId,
    dateStamp,
    region,
    service,
    amzDate,
    expiresSeconds,
    signedHeaders: signedHeaders.split(";"),
    signature,
  };
}

function parseAmzDate(value: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}

function stripSignature(query: URLSearchParams): URLSearchParams {
  const clone = new URLSearchParams();
  for (const [key, value] of query) {
    if (key === "X-Amz-Signature") continue;
    clone.append(key, value);
  }
  return clone;
}

export class SigV4PresignedVerifier {
  constructor(
    private readonly config: AppConfig,
    private readonly credentials: S3CredentialsRepository,
  ) {}

  /** Returns null when the request is not presigned, so the caller can fall
   *  back to Authorization-header verification. */
  verify(input: {
    method: string;
    pathname: string;
    query: URLSearchParams;
    headers: Headers;
  }): SigV4Result | null {
    const parsed = parsePresigned(input.query);
    if (!parsed) return null;

    const ts = parseAmzDate(parsed.amzDate);
    if (ts === null) return failure("MalformedAuthorization");
    if (parsed.dateStamp !== parsed.amzDate.slice(0, 8)) {
      return failure("CredentialScopeMismatch");
    }
    if (parsed.region !== this.config.s3Region || parsed.service !== "s3") {
      return failure("CredentialScopeMismatch");
    }
    if (
      parsed.expiresSeconds < this.config.presignedMinExpiresSeconds ||
      parsed.expiresSeconds > this.config.presignedMaxExpiresSeconds
    ) {
      return failure("MalformedAuthorization");
    }
    if (Date.now() > ts + parsed.expiresSeconds * 1000) {
      return failure("RequestTimeTooSkewed");
    }
    if (!parsed.signedHeaders.map((name) => name.toLowerCase()).includes("host")) {
      return failure("MalformedAuthorization");
    }
    if (parsed.signedHeaders.some((name) => !input.headers.has(name))) {
      return failure("SignatureDoesNotMatch");
    }
    if (!/^[0-9a-f]{64}$/.test(parsed.signature)) {
      return failure("MalformedAuthorization");
    }
    const cred = this.credentials.findActiveByAccessKeyId(parsed.accessKeyId);
    if (!cred) return failure("InvalidAccessKeyId");

    const { canonicalRequest } = buildCanonicalRequest({
      method: input.method,
      path: input.pathname,
      query: stripSignature(input.query),
      headers: input.headers,
      signedHeaderNames: parsed.signedHeaders,
      payloadHash: UNSIGNED_PAYLOAD,
    });
    const scope = `${parsed.dateStamp}/${parsed.region}/${parsed.service}/aws4_request`;
    const stringToSign = buildStringToSign({
      amzDate: parsed.amzDate,
      scope,
      canonicalRequest,
    });

    const expected = this.computeExpected(cred, parsed, stringToSign);
    if (!expected) return failure("SignatureDoesNotMatch");
    const a = Buffer.from(parsed.signature, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return failure("SignatureDoesNotMatch");
    }

    this.credentials.markUsed(cred.id);
    return { ok: true, userId: cred.user_id, credentialId: cred.id };
  }

  private computeExpected(
    cred: CredentialRow,
    parsed: ParsedPresign,
    stringToSign: string,
  ): string | null {
    let secret: string;
    try {
      secret = openFromString(
        cred.encrypted_secret_key,
        this.config.masterEncryptionKey,
        aad.s3Secret(cred.id),
      );
    } catch {
      return null;
    }
    try {
      const signingKey = deriveSigningKey(secret, parsed.dateStamp, parsed.region, parsed.service);
      return computeSignature(signingKey, stringToSign);
    } finally {
      secret = "";
      void secret;
    }
  }
}

function failure(failureKind: SigV4Failure): SigV4Result {
  return { ok: false, failure: failureKind };
}
