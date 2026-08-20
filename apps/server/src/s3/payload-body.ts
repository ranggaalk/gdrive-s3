import { parseS3PayloadMode, type S3PayloadMode } from "../auth/s3-payload.ts";
import type { S3RequestContext } from "./context.ts";
import { decodeAwsChunkedBody } from "./aws-chunked.ts";
import { S3Error } from "./errors.ts";

export interface PreparedPayload {
  body: ReadableStream<Uint8Array>;
  mode: S3PayloadMode;
  contentLength: number | null;
}

function numericHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null) return null;
  if (!/^\d+$/.test(value)) throw new S3Error("InvalidRequest", { Reason: `Invalid ${name}.` });
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new S3Error("InvalidRequest", { Reason: `Invalid ${name}.` });
  }
  return parsed;
}

export function preparePayload(ctx: S3RequestContext): PreparedPayload {
  if (!ctx.body) throw new S3Error("InvalidRequest", { Reason: "Missing request body." });
  const mode = parseS3PayloadMode(ctx.headers.get("x-amz-content-sha256"));
  if (mode.kind === "unsupported") {
    throw new S3Error("NotImplemented", { Feature: mode.marker });
  }

  if (mode.kind === "streaming-signed") {
    if (!ctx.streamingAuth) throw new S3Error("SignatureDoesNotMatch");
    const decodedLength = numericHeader(ctx.headers, "x-amz-decoded-content-length");
    return {
      // MinIO sends a concrete wire Content-Length plus a smaller decoded length:
      // Request.body still contains the SigV4 chunk records even when it omits
      // Content-Encoding: aws-chunked. Decode and authenticate them by payload mode.
      body: decodeAwsChunkedBody(ctx.body, ctx.streamingAuth, decodedLength),
      mode,
      contentLength: decodedLength,
    };
  }

  return {
    body: ctx.body,
    mode,
    contentLength: numericHeader(ctx.headers, "content-length"),
  };
}

export function assertPayloadDigest(mode: S3PayloadMode, actualSha256Hex: string): void {
  if (mode.kind === "digest" && mode.sha256Hex !== actualSha256Hex) {
    throw new S3Error("SignatureDoesNotMatch");
  }
}
