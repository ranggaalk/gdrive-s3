// A deliberately small S3 client for backup destinations: PutObject and
// multipart upload, nothing else. It signs with the same SigV4
// canonicalization the gateway verifies with, and sends through an injectable
// fetch so tests can aim it at another in-process gateway.
//
// Bodies are always whole byte arrays. That costs one part of memory per
// running copy, and buys an exact Content-Length, a signed payload hash and a
// Content-MD5 the destination checks -- plus requests that are safe to retry.

import { createHash } from "node:crypto";
import {
  ALGORITHM,
  buildCanonicalRequest,
  buildStringToSign,
  canonicalQuery,
  computeSignature,
  deriveSigningKey,
  sha256Hex,
  uriEncode,
} from "../auth/sigv4-canonical.ts";
import { abortableSleep } from "../drive/retry.ts";
import type { FetchLike } from "../util/fetch-like.ts";
import { ChunkReader } from "./chunk-reader.ts";

export interface S3ClientOptions {
  /** Scheme and host, e.g. https://s3.eu-west-1.amazonaws.com */
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  fetch: FetchLike;
  maxAttempts: number;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** S3 refuses more parts than this in one upload. */
export const MAX_PARTS = 10_000;
const MIB = 1024 * 1024;
const EMPTY = new Uint8Array(0);

// Codes that condemn the destination rather than the one object: every
// remaining request would get the same answer.
const DESTINATION_CODES = new Set([
  "AccessDenied",
  "AccountProblem",
  "AllAccessDisabled",
  "AuthorizationHeaderMalformed",
  "ExpiredToken",
  "InvalidAccessKeyId",
  "InvalidBucketName",
  "InvalidToken",
  "NoSuchBucket",
  "NotSignedUp",
  "PermanentRedirect",
  "RequestTimeTooSkewed",
  "SignatureDoesNotMatch",
]);

const RETRYABLE_CODES = new Set(["InternalError", "RequestTimeout", "ServiceUnavailable", "SlowDown"]);

export class S3RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "S3RequestError";
  }

  get retryable(): boolean {
    return this.status >= 500 || this.status === 429 || (this.code !== null && RETRYABLE_CODES.has(this.code));
  }

  get destinationLevel(): boolean {
    if (this.code !== null && DESTINATION_CODES.has(this.code)) return true;
    // A redirect means the wrong endpoint or region; 401/403 without an S3
    // body usually means a proxy or a provider that does not speak S3 errors.
    return this.status === 301 || this.status === 307 || this.status === 401 || this.status === 403;
  }
}

/** fetch itself failed: DNS, a refused connection, TLS. */
export class S3NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "S3NetworkError";
  }
}

interface SendInput {
  method: "PUT" | "POST" | "DELETE";
  key: string;
  query?: Record<string, string>;
  headers?: Headers;
  body?: Uint8Array;
  /** CompleteMultipartUpload can answer 200 and still carry an <Error>. */
  errorIn200?: boolean;
}

interface SendResult {
  headers: Headers;
  text: string;
}

export class S3Client {
  constructor(private readonly options: S3ClientOptions) {}

  async putObject(key: string, body: Uint8Array, headers: Headers, signal?: AbortSignal): Promise<void> {
    const withDigest = new Headers(headers);
    withDigest.set("content-md5", md5Base64(body));
    await this.send({ method: "PUT", key, headers: withDigest, body }, signal);
  }

  async createMultipartUpload(key: string, headers: Headers, signal?: AbortSignal): Promise<string> {
    const result = await this.send({ method: "POST", key, query: { uploads: "" }, headers }, signal);
    const uploadId = xmlValue(result.text, "UploadId");
    if (!uploadId) throw new S3RequestError(200, null, "CreateMultipartUpload returned no UploadId");
    return uploadId;
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.send(
      {
        method: "PUT",
        key,
        query: { partNumber: String(partNumber), uploadId },
        headers: new Headers({ "content-md5": md5Base64(body) }),
        body,
      },
      signal,
    );
    const etag = result.headers.get("etag");
    if (!etag) throw new S3RequestError(200, null, `UploadPart ${partNumber} returned no ETag`);
    return etag;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>,
    signal?: AbortSignal,
  ): Promise<void> {
    const xml =
      "<CompleteMultipartUpload>" +
      parts
        .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`)
        .join("") +
      "</CompleteMultipartUpload>";
    await this.send(
      {
        method: "POST",
        key,
        query: { uploadId },
        headers: new Headers({ "content-type": "application/xml" }),
        body: new TextEncoder().encode(xml),
        errorIn200: true,
      },
      signal,
    );
  }

  /** S3 answers 204 whether or not the key existed. */
  async deleteObject(key: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.send({ method: "DELETE", key }, signal);
    } catch (error) {
      if (error instanceof S3RequestError && error.code === "NoSuchKey") return;
      throw error;
    }
  }

  async abortMultipartUpload(key: string, uploadId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.send({ method: "DELETE", key, query: { uploadId } }, signal);
    } catch (error) {
      if (error instanceof S3RequestError && error.code === "NoSuchUpload") return;
      throw error;
    }
  }

  private async send(input: SendInput, signal?: AbortSignal): Promise<SendResult> {
    const maxAttempts = Math.max(1, this.options.maxAttempts);
    const sleep = this.options.sleep ?? abortableSleep;
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      try {
        return await this.sendOnce(input, signal);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        const retryable =
          error instanceof S3RequestError ? error.retryable : error instanceof S3NetworkError;
        if (!retryable || attempt >= maxAttempts) throw error;
        const exponential = Math.min(10_000, 250 * 2 ** (attempt - 1));
        await sleep(exponential + Math.floor(exponential * 0.25 * Math.random()), signal);
      }
    }
  }

  private async sendOnce(input: SendInput, signal?: AbortSignal): Promise<SendResult> {
    const { region, accessKeyId, secretAccessKey } = this.options;
    const url = this.url(input.key, input.query ?? {});
    const body = input.body ?? EMPTY;
    const amzDate = formatAmzDate((this.options.now ?? (() => new Date()))());
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(body);

    const headers = new Headers(input.headers);
    headers.set("host", url.host);
    headers.set("x-amz-date", amzDate);
    headers.set("x-amz-content-sha256", payloadHash);
    // Every header sent is signed, so nothing in transit can be swapped.
    const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
      method: input.method,
      path: url.pathname,
      query: url.searchParams,
      headers,
      signedHeaderNames: [...headers.keys()],
      payloadHash,
    });
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const signature = computeSignature(
      deriveSigningKey(secretAccessKey, dateStamp, region, "s3"),
      buildStringToSign({ amzDate, scope, canonicalRequest }),
    );
    headers.set(
      "authorization",
      `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    );

    let response: Response;
    try {
      response = await this.options.fetch(url.toString(), {
        method: input.method,
        headers,
        body: input.body,
        signal,
        // A redirect is S3 saying "wrong region or endpoint"; following it
        // would only fail the signature somewhere else.
        redirect: "manual",
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new S3NetworkError(`could not reach ${url.host}: ${reason}`);
    }
    const text = await response.text().catch(() => "");
    if (response.status >= 300 || (input.errorIn200 && /<Error>/.test(text))) {
      const status = response.status >= 300 ? response.status : 500;
      const code = xmlValue(text, "Code");
      const message = xmlValue(text, "Message");
      throw new S3RequestError(status, code, `${code ?? `HTTP ${status}`}${message ? `: ${message}` : ""}`);
    }
    return { headers: response.headers, text };
  }

  private url(key: string, query: Record<string, string>): URL {
    const base = new URL(this.options.endpoint);
    const encodedKey = uriEncode(key, false);
    const url = this.options.forcePathStyle
      ? new URL(`${base.protocol}//${base.host}/${uriEncode(this.options.bucket)}/${encodedKey}`)
      : new URL(`${base.protocol}//${this.options.bucket}.${base.host}/${encodedKey}`);
    // Sent exactly as it is signed, rather than in URLSearchParams' form
    // encoding, which differs from SigV4's for characters like "*" and "~".
    const search = canonicalQuery(new URLSearchParams(query));
    if (search) url.search = search;
    return url;
  }
}

/**
 * Uploads a stream to one key: a single PUT when it fits in one part,
 * multipart otherwise. A failed multipart upload is aborted so the
 * destination does not keep (and bill for) its orphaned parts.
 */
export async function uploadStream(
  client: S3Client,
  key: string,
  body: ReadableStream<Uint8Array>,
  options: { partSize: number; headers: Headers; signal?: AbortSignal },
): Promise<void> {
  const { partSize, headers, signal } = options;
  const reader = new ChunkReader(body);
  let finished = false;
  try {
    const first = await reader.read(partSize);
    const second = first.byteLength === partSize ? await reader.read(partSize) : EMPTY;
    if (second.byteLength === 0) {
      await client.putObject(key, first, headers, signal);
      finished = true;
      return;
    }

    const uploadId = await client.createMultipartUpload(key, headers, signal);
    try {
      const parts: Array<{ partNumber: number; etag: string }> = [];
      let chunk = first;
      let queued: Uint8Array | null = second;
      for (let partNumber = 1; chunk.byteLength > 0; partNumber++) {
        if (partNumber > MAX_PARTS) {
          throw new Error(`object needs more than ${MAX_PARTS} parts of ${partSize / MIB} MiB`);
        }
        parts.push({ partNumber, etag: await client.uploadPart(key, uploadId, partNumber, chunk, signal) });
        if (queued) {
          chunk = queued;
          queued = null;
        } else {
          chunk = await reader.read(partSize);
        }
      }
      await client.completeMultipartUpload(key, uploadId, parts, signal);
      finished = true;
    } catch (error) {
      // Not under the run's signal: a cancelled run is exactly when the parts
      // most need cleaning up.
      await client.abortMultipartUpload(key, uploadId, AbortSignal.timeout(30_000)).catch(() => {});
      throw error;
    }
  } finally {
    if (!finished) await reader.cancel();
  }
}

/** The part size for an object of roughly this size: the configured size,
 *  raised in whole MiB if the object would otherwise need too many parts. */
export function partSizeFor(sizeHint: number, configured: number): number {
  const needed = Math.ceil(sizeHint / (MAX_PARTS - 1) / MIB) * MIB;
  return Math.max(configured, needed);
}

function md5Base64(body: Uint8Array): string {
  return createHash("md5").update(body).digest("base64");
}

function formatAmzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function xmlValue(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!match) return null;
  return match[1]!
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
