// AWS SigV4 request verifier for the S3 data plane (AGENTS.md §11).
// Header-signed requests + UNSIGNED-PAYLOAD. Presigned query auth is Milestone 6.
// The secret is decrypted only for the duration of verification, then dropped.

import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config.ts";
import { S3CredentialsRepository } from "../db/repositories/s3-credentials.ts";
import type { CredentialRow } from "../db/repositories/s3-credentials.ts";
import { openFromString, aad } from "../security/encryption.ts";
import {
  ALGORITHM,
  UNSIGNED_PAYLOAD,
  buildCanonicalRequest,
  buildStringToSign,
  computeSignature,
  deriveSigningKey,
  sha256Hex,
} from "./sigv4-canonical.ts";

const MAX_SKEW_MS = 15 * 60 * 1000;

export type SigV4Failure =
  | "MissingAuthorization"
  | "MalformedAuthorization"
  | "InvalidAccessKeyId"
  | "SignatureDoesNotMatch"
  | "RequestTimeTooSkewed"
  | "CredentialScopeMismatch"
  | "UnsignedNotAllowed";

export interface SigV4Success {
  ok: true;
  userId: string;
  credentialId: string;
  streaming?: {
    signingKey: Buffer;
    seedSignature: string;
    amzDate: string;
    scope: string;
  };
}
export interface SigV4Rejected {
  ok: false;
  failure: SigV4Failure;
}
export type SigV4Result = SigV4Success | SigV4Rejected;

interface ParsedAuth {
  accessKeyId: string;
  dateStamp: string;
  region: string;
  service: string;
  signedHeaders: string[];
  signature: string;
}

function parseAuthorization(header: string): ParsedAuth | null {
  if (!header.startsWith(`${ALGORITHM} `)) return null;
  const rest = header.slice(ALGORITHM.length + 1);
  const parts = Object.fromEntries(
    rest.split(",").map((kv) => {
      const idx = kv.indexOf("=");
      return [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
    }),
  ) as Record<string, string>;

  const credential = parts["Credential"];
  const signedHeaders = parts["SignedHeaders"];
  const signature = parts["Signature"];
  if (!credential || !signedHeaders || !signature) return null;

  const cparts = credential.split("/");
  if (cparts.length !== 5) return null;
  const [accessKeyId, dateStamp, region, service, terminator] = cparts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (terminator !== "aws4_request") return null;

  return {
    accessKeyId,
    dateStamp,
    region,
    service,
    signedHeaders: signedHeaders.split(";"),
    signature,
  };
}

/** Parse YYYYMMDDTHHMMSSZ into epoch ms, or null if malformed. */
function parseAmzDate(value: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!);
}

export class SigV4Verifier {
  constructor(
    private readonly config: AppConfig,
    private readonly credentials: S3CredentialsRepository,
  ) {}

  /**
   * Verify a header-signed request. `payloadHash` must be the value the client
   * put in x-amz-content-sha256 (hex sha256, UNSIGNED-PAYLOAD, or a streaming
   * marker). For UNSIGNED-PAYLOAD we sign the literal string per the spec.
   */
  verify(input: {
    method: string;
    pathname: string;
    query: URLSearchParams;
    headers: Headers;
  }): SigV4Result {
    const authHeader = input.headers.get("authorization");
    if (!authHeader) return { ok: false, failure: "MissingAuthorization" };

    const parsed = parseAuthorization(authHeader);
    if (!parsed) return { ok: false, failure: "MalformedAuthorization" };

    if (parsed.region !== this.config.s3Region || parsed.service !== "s3") {
      return { ok: false, failure: "CredentialScopeMismatch" };
    }

    // Clock skew from x-amz-date (fallback Date).
    const amzDate = input.headers.get("x-amz-date") ?? "";
    const ts = parseAmzDate(amzDate);
    if (ts === null) return { ok: false, failure: "MalformedAuthorization" };
    if (Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
      return { ok: false, failure: "RequestTimeTooSkewed" };
    }

    const cred = this.credentials.findActiveByAccessKeyId(parsed.accessKeyId);
    if (!cred) return { ok: false, failure: "InvalidAccessKeyId" };

    // Every declared signed header must exist on the wire; otherwise a missing
    // header could canonicalize as an empty value and accidentally verify.
    if (!parsed.signedHeaders.includes("host")) {
      return { ok: false, failure: "MalformedAuthorization" };
    }
    if (parsed.signedHeaders.some((name) => !input.headers.has(name))) {
      return { ok: false, failure: "SignatureDoesNotMatch" };
    }
    if (!/^[0-9a-f]{64}$/.test(parsed.signature)) {
      return { ok: false, failure: "MalformedAuthorization" };
    }
    if (parsed.dateStamp !== amzDate.slice(0, 8)) {
      return { ok: false, failure: "CredentialScopeMismatch" };
    }

    const payloadHash = input.headers.get("x-amz-content-sha256") ?? UNSIGNED_PAYLOAD;

    const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
      method: input.method,
      path: input.pathname,
      query: input.query,
      headers: input.headers,
      signedHeaderNames: parsed.signedHeaders,
      payloadHash,
    });
    void signedHeaders;

    const scope = `${parsed.dateStamp}/${parsed.region}/${parsed.service}/aws4_request`;
    const stringToSign = buildStringToSign({ amzDate, scope, canonicalRequest });

    const computed = this.computeExpected(cred, parsed, stringToSign);
    if (!computed) return { ok: false, failure: "SignatureDoesNotMatch" };

    const a = Buffer.from(parsed.signature, "utf8");
    const b = Buffer.from(computed.expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      computed.signingKey.fill(0);
      return { ok: false, failure: "SignatureDoesNotMatch" };
    }

    this.credentials.markUsed(cred.id);
    if (payloadHash === "STREAMING-AWS4-HMAC-SHA256-PAYLOAD") {
      return {
        ok: true,
        userId: cred.user_id,
        credentialId: cred.id,
        streaming: {
          signingKey: computed.signingKey,
          seedSignature: parsed.signature,
          amzDate,
          scope,
        },
      };
    }
    computed.signingKey.fill(0);
    return { ok: true, userId: cred.user_id, credentialId: cred.id };
  }

  private computeExpected(
    cred: CredentialRow,
    parsed: ParsedAuth,
    stringToSign: string,
  ): { expected: string; signingKey: Buffer } | null {
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
      return { expected: computeSignature(signingKey, stringToSign), signingKey };
    } finally {
      // best-effort scrub of the plaintext reference
      secret = "";
      void secret;
    }
  }
}

export { sha256Hex };
