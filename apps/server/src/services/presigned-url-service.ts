import type { AppConfig } from "../config.ts";
import type { ObjectRow } from "../db/repositories/objects.ts";
import type { S3CredentialsRepository } from "../db/repositories/s3-credentials.ts";
import { aad, openFromString } from "../security/encryption.ts";
import {
  ALGORITHM,
  UNSIGNED_PAYLOAD,
  buildCanonicalRequest,
  buildStringToSign,
  computeSignature,
  deriveSigningKey,
  uriEncode,
} from "../auth/sigv4-canonical.ts";

export class PresignCredentialNotFoundError extends Error {}
export class PresignExpiryError extends Error {}
export class PresignPostInputError extends Error {}

export interface PresignedPostResult {
  url: string;
  /** Form fields to render, in the order a browser should submit them. The
   *  file input must come last. */
  fields: Record<string, string>;
  expiresAt: string;
  credentialId: string;
  keyTemplate: string;
  maxBytes: number;
}

export class PresignedUrlService {
  constructor(
    private readonly config: AppConfig,
    private readonly credentials: S3CredentialsRepository,
  ) {}

  createGet(input: {
    userId: string;
    credentialId: string;
    bucketName: string;
    object: ObjectRow;
    expiresSeconds: number;
    now?: Date;
  }): { url: string; expiresAt: string; credentialId: string } {
    if (
      !Number.isInteger(input.expiresSeconds) ||
      input.expiresSeconds < this.config.presignedMinExpiresSeconds ||
      input.expiresSeconds > this.config.presignedMaxExpiresSeconds
    ) {
      throw new PresignExpiryError();
    }
    const credential = this.credentials.findByIdOwned(input.userId, input.credentialId);
    if (!credential || credential.status !== "active") {
      throw new PresignCredentialNotFoundError();
    }

    const now = input.now ?? new Date();
    const amzDate = formatAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${this.config.s3Region}/s3/aws4_request`;
    const endpoint = new URL(this.config.s3PublicEndpoint);
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      (endpoint.pathname !== "/" && endpoint.pathname !== "")
    ) {
      throw new Error("S3 public endpoint must be a clean origin");
    }
    const encodedPath = `/${uriEncode(input.bucketName)}/${encodeS3Key(input.object.object_key)}`;
    endpoint.searchParams.set("X-Amz-Algorithm", ALGORITHM);
    endpoint.searchParams.set("X-Amz-Credential", `${credential.access_key_id}/${scope}`);
    endpoint.searchParams.set("X-Amz-Date", amzDate);
    endpoint.searchParams.set("X-Amz-Expires", String(input.expiresSeconds));
    endpoint.searchParams.set("X-Amz-SignedHeaders", "host");

    const headers = new Headers({ host: endpoint.host });
    const { canonicalRequest } = buildCanonicalRequest({
      method: "GET",
      path: encodedPath,
      query: endpoint.searchParams,
      headers,
      signedHeaderNames: ["host"],
      payloadHash: UNSIGNED_PAYLOAD,
    });
    const stringToSign = buildStringToSign({ amzDate, scope, canonicalRequest });
    let secret = openFromString(
      credential.encrypted_secret_key,
      this.config.masterEncryptionKey,
      aad.s3Secret(credential.id),
    );
    try {
      const signingKey = deriveSigningKey(secret, dateStamp, this.config.s3Region, "s3");
      try {
        endpoint.searchParams.set("X-Amz-Signature", computeSignature(signingKey, stringToSign));
      } finally {
        signingKey.fill(0);
      }
    } finally {
      secret = "";
      void secret;
    }

    const query = endpoint.search;
    return {
      url: `${endpoint.origin}${encodedPath}${query}`,
      expiresAt: new Date(now.getTime() + input.expiresSeconds * 1000).toISOString(),
      credentialId: credential.id,
    };
  }

  /**
   * Build a signed POST policy so a browser can upload straight to the gateway
   * without ever holding the secret key.
   *
   * The policy pins the bucket, constrains the key to a prefix, and bounds the
   * upload size. Every field returned in `fields` has a matching condition,
   * because the gateway rejects any field the policy does not cover.
   */
  createPost(input: {
    userId: string;
    credentialId: string;
    bucketName: string;
    keyPrefix: string;
    expiresSeconds: number;
    maxBytes: number;
    minBytes?: number;
    now?: Date;
  }): PresignedPostResult {
    if (
      !Number.isInteger(input.expiresSeconds) ||
      input.expiresSeconds < this.config.presignedMinExpiresSeconds ||
      input.expiresSeconds > this.config.presignedMaxExpiresSeconds
    ) {
      throw new PresignExpiryError();
    }
    const minBytes = input.minBytes ?? 0;
    if (
      !Number.isSafeInteger(input.maxBytes) ||
      !Number.isSafeInteger(minBytes) ||
      minBytes < 0 ||
      input.maxBytes < minBytes ||
      input.maxBytes > this.config.maxSinglePutBytes
    ) {
      throw new PresignPostInputError("maxBytes is outside the permitted range");
    }
    // A prefix that escapes upward would let the form write outside the folder
    // the operator picked.
    if (input.keyPrefix.includes("..") || input.keyPrefix.startsWith("/")) {
      throw new PresignPostInputError("keyPrefix must be a relative path without ..");
    }

    const credential = this.credentials.findByIdOwned(input.userId, input.credentialId);
    if (!credential || credential.status !== "active") {
      throw new PresignCredentialNotFoundError();
    }

    const now = input.now ?? new Date();
    const amzDate = formatAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${this.config.s3Region}/s3/aws4_request`;
    const credentialField = `${credential.access_key_id}/${scope}`;
    const expiresAt = new Date(now.getTime() + input.expiresSeconds * 1000);
    const keyTemplate = `${input.keyPrefix}\${filename}`;

    const endpoint = new URL(this.config.s3PublicEndpoint);
    assertCleanEndpoint(endpoint);

    const policy = {
      expiration: expiresAt.toISOString(),
      conditions: [
        { bucket: input.bucketName },
        ["starts-with", "$key", input.keyPrefix],
        { "x-amz-algorithm": ALGORITHM },
        { "x-amz-credential": credentialField },
        { "x-amz-date": amzDate },
        ["content-length-range", minBytes, input.maxBytes],
      ],
    };
    const policyBase64 = Buffer.from(JSON.stringify(policy), "utf8").toString("base64");

    let secret = openFromString(
      credential.encrypted_secret_key,
      this.config.masterEncryptionKey,
      aad.s3Secret(credential.id),
    );
    let signature: string;
    try {
      const signingKey = deriveSigningKey(secret, dateStamp, this.config.s3Region, "s3");
      try {
        signature = computeSignature(signingKey, policyBase64);
      } finally {
        signingKey.fill(0);
      }
    } finally {
      secret = "";
      void secret;
    }

    return {
      url: `${endpoint.origin}/${uriEncode(input.bucketName)}`,
      fields: {
        key: keyTemplate,
        "x-amz-algorithm": ALGORITHM,
        "x-amz-credential": credentialField,
        "x-amz-date": amzDate,
        policy: policyBase64,
        "x-amz-signature": signature,
      },
      expiresAt: expiresAt.toISOString(),
      credentialId: credential.id,
      keyTemplate,
      maxBytes: input.maxBytes,
    };
  }
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function assertCleanEndpoint(endpoint: URL): void {
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "")
  ) {
    throw new Error("S3 public endpoint must be a clean origin");
  }
}

function encodeS3Key(key: string): string {
  return key.split("/").map((segment) => uriEncode(segment)).join("/");
}
