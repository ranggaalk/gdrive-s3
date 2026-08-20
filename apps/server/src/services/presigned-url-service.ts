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
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function encodeS3Key(key: string): string {
  return key.split("/").map((segment) => uriEncode(segment)).join("/");
}
