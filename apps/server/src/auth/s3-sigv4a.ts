// SigV4A verifier for the S3 data plane. Handles both the Authorization-header
// form and the presigned-query form, returning the same SigV4Result the SigV4
// verifiers produce so the router does not have to care which scheme a client
// picked.
//
// The secret is decrypted only for the duration of verification, then dropped.

import type { AppConfig } from "../config.ts";
import { S3CredentialsRepository } from "../db/repositories/s3-credentials.ts";
import type { CredentialRow } from "../db/repositories/s3-credentials.ts";
import { openFromString, aad } from "../security/encryption.ts";
import { UNSIGNED_PAYLOAD, buildCanonicalRequest, buildStringToSign } from "./sigv4-canonical.ts";
import type { SigV4Failure, SigV4Result } from "./s3-sigv4.ts";
import {
  ALGORITHM_V4A,
  REGION_SET_HEADER,
  REGION_SET_PARAM,
  isValidDerSignatureHex,
  regionSetMatches,
  sigV4aScope,
  verifySigV4aSignature,
} from "./sigv4a.ts";

const MAX_SKEW_MS = 15 * 60 * 1000;

interface ParsedV4a {
  accessKeyId: string;
  dateStamp: string;
  service: string;
  amzDate: string;
  signedHeaders: string[];
  signature: string;
  regionSet: string;
  /** Present only for the presigned-query form. */
  expiresSeconds: number | null;
}

function failure(kind: SigV4Failure): SigV4Result {
  return { ok: false, failure: kind };
}

/** SigV4A credentials carry four parts — the region SigV4 puts here is gone. */
function parseCredential(
  credential: string,
): { accessKeyId: string; dateStamp: string; service: string } | null {
  const parts = credential.split("/");
  if (parts.length !== 4) return null;
  const [accessKeyId, dateStamp, service, terminator] = parts as [string, string, string, string];
  if (terminator !== "aws4_request") return null;
  if (!accessKeyId || !dateStamp || !service) return null;
  return { accessKeyId, dateStamp, service };
}

function parseAmzDate(value: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}

function parseHeaderForm(headers: Headers): ParsedV4a | null {
  const authHeader = headers.get("authorization");
  if (!authHeader || !authHeader.startsWith(`${ALGORITHM_V4A} `)) return null;

  const rest = authHeader.slice(ALGORITHM_V4A.length + 1);
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

  const parsedCredential = parseCredential(credential);
  if (!parsedCredential) return null;

  return {
    ...parsedCredential,
    amzDate: headers.get("x-amz-date") ?? "",
    signedHeaders: signedHeaders.split(";"),
    signature,
    regionSet: headers.get(REGION_SET_HEADER) ?? "",
    expiresSeconds: null,
  };
}

function parseQueryForm(query: URLSearchParams): ParsedV4a | null {
  if (query.get("X-Amz-Algorithm") !== ALGORITHM_V4A) return null;

  const credential = query.get("X-Amz-Credential");
  const amzDate = query.get("X-Amz-Date");
  const expiresRaw = query.get("X-Amz-Expires");
  const signedHeaders = query.get("X-Amz-SignedHeaders");
  const signature = query.get("X-Amz-Signature");
  if (!credential || !amzDate || !expiresRaw || !signedHeaders || !signature) return null;

  const parsedCredential = parseCredential(credential);
  if (!parsedCredential) return null;

  const expiresSeconds = Number(expiresRaw);
  if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1) return null;

  return {
    ...parsedCredential,
    amzDate,
    signedHeaders: signedHeaders.split(";"),
    signature,
    regionSet: query.get(REGION_SET_PARAM) ?? "",
    expiresSeconds,
  };
}

/** Canonical query for the presigned form excludes the signature itself. */
function stripSignature(query: URLSearchParams): URLSearchParams {
  const clone = new URLSearchParams();
  for (const [key, value] of query) {
    if (key === "X-Amz-Signature") continue;
    clone.append(key, value);
  }
  return clone;
}

export class SigV4aVerifier {
  constructor(
    private readonly config: AppConfig,
    private readonly credentials: S3CredentialsRepository,
  ) {}

  /** Returns null when the request is not SigV4A at all, so the caller can fall
   *  back to the SigV4 verifiers. */
  verify(input: {
    method: string;
    pathname: string;
    query: URLSearchParams;
    headers: Headers;
  }): SigV4Result | null {
    const presigned = parseQueryForm(input.query);
    const parsed = presigned ?? parseHeaderForm(input.headers);
    if (!parsed) {
      // A v4a algorithm we could not parse must not silently fall through to
      // the SigV4 verifier, which would report a confusing "missing header".
      if (
        input.query.get("X-Amz-Algorithm") === ALGORITHM_V4A ||
        input.headers.get("authorization")?.startsWith(`${ALGORITHM_V4A} `)
      ) {
        return failure("MalformedAuthorization");
      }
      return null;
    }

    if (parsed.service !== "s3") return failure("CredentialScopeMismatch");

    const ts = parseAmzDate(parsed.amzDate);
    if (ts === null) return failure("MalformedAuthorization");
    if (parsed.dateStamp !== parsed.amzDate.slice(0, 8)) {
      return failure("CredentialScopeMismatch");
    }

    if (!regionSetMatches(parsed.regionSet, this.config.s3Region)) {
      return failure("CredentialScopeMismatch");
    }

    if (parsed.expiresSeconds === null) {
      if (Math.abs(Date.now() - ts) > MAX_SKEW_MS) return failure("RequestTimeTooSkewed");
    } else {
      if (
        parsed.expiresSeconds < this.config.presignedMinExpiresSeconds ||
        parsed.expiresSeconds > this.config.presignedMaxExpiresSeconds
      ) {
        return failure("MalformedAuthorization");
      }
      if (Date.now() > ts + parsed.expiresSeconds * 1000) {
        return failure("RequestTimeTooSkewed");
      }
    }

    const signedHeaderNames = parsed.signedHeaders.map((name) => name.toLowerCase());
    if (!signedHeaderNames.includes("host")) return failure("MalformedAuthorization");
    // The region set is what scopes the signature to this gateway; a client that
    // leaves it unsigned could have it rewritten in flight.
    if (parsed.expiresSeconds === null && !signedHeaderNames.includes(REGION_SET_HEADER)) {
      return failure("MalformedAuthorization");
    }
    // Every declared signed header must exist on the wire, or a missing header
    // would canonicalize as an empty value and could accidentally verify.
    if (signedHeaderNames.some((name) => !input.headers.has(name))) {
      return failure("SignatureDoesNotMatch");
    }
    if (!isValidDerSignatureHex(parsed.signature)) return failure("MalformedAuthorization");

    const cred = this.credentials.findActiveByAccessKeyId(parsed.accessKeyId);
    if (!cred) return failure("InvalidAccessKeyId");

    // Chunked upload signing under SigV4A uses a per-chunk ECDSA scheme this
    // gateway does not implement. Reject it rather than half-authenticate it.
    const payloadHash = parsed.expiresSeconds === null
      ? (input.headers.get("x-amz-content-sha256") ?? UNSIGNED_PAYLOAD)
      : UNSIGNED_PAYLOAD;
    if (payloadHash.startsWith("STREAMING-")) return failure("UnsignedNotAllowed");

    const { canonicalRequest } = buildCanonicalRequest({
      method: input.method,
      path: input.pathname,
      query: parsed.expiresSeconds === null ? input.query : stripSignature(input.query),
      headers: input.headers,
      signedHeaderNames,
      payloadHash,
    });

    const scope = sigV4aScope(parsed.dateStamp, parsed.service);
    const stringToSign = buildStringToSign({
      amzDate: parsed.amzDate,
      scope,
      canonicalRequest,
      algorithm: ALGORITHM_V4A,
    });

    if (!this.verifyAgainstCredential(cred, parsed.accessKeyId, parsed.signature, stringToSign)) {
      return failure("SignatureDoesNotMatch");
    }

    this.credentials.markUsed(cred.id);
    return { ok: true, userId: cred.user_id, credentialId: cred.id };
  }

  private verifyAgainstCredential(
    cred: CredentialRow,
    accessKeyId: string,
    signatureHex: string,
    stringToSign: string,
  ): boolean {
    let secret: string;
    try {
      secret = openFromString(
        cred.encrypted_secret_key,
        this.config.masterEncryptionKey,
        aad.s3Secret(cred.id),
      );
    } catch {
      return false;
    }
    try {
      return verifySigV4aSignature({
        accessKeyId,
        secretAccessKey: secret,
        stringToSign,
        signatureDer: Buffer.from(signatureHex, "hex"),
      });
    } finally {
      secret = "";
      void secret;
    }
  }
}
