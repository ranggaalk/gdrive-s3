// Extract and validate S3 object metadata headers (AGENTS.md §13).

import { S3Error } from "./errors.ts";

const MAX_METADATA_COUNT = 50;
const MAX_METADATA_NAME_BYTES = 128;
const MAX_METADATA_VALUE_BYTES = 2048;
const MAX_METADATA_TOTAL_BYTES = 8192;

export interface ObjectMetadataHeaders {
  contentType: string;
  cacheControl: string | null;
  contentDisposition: string | null;
  contentEncoding: string | null;
  contentLanguage: string | null;
  expiresAt: string | null;
  userMetadata: Record<string, string>;
}

export function parseObjectMetadata(headers: Headers): ObjectMetadataHeaders {
  const userMetadata: Record<string, string> = {};
  let total = 0;
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (!lower.startsWith("x-amz-meta-")) continue;
    const key = lower.slice("x-amz-meta-".length);
    if (!key || Buffer.byteLength(key) > MAX_METADATA_NAME_BYTES) {
      throw new S3Error("InvalidArgument", { ArgumentName: name });
    }
    if (Buffer.byteLength(value) > MAX_METADATA_VALUE_BYTES) {
      throw new S3Error("InvalidArgument", { ArgumentName: name });
    }
    total += Buffer.byteLength(key) + Buffer.byteLength(value);
    userMetadata[key] = value;
  }
  if (Object.keys(userMetadata).length > MAX_METADATA_COUNT || total > MAX_METADATA_TOTAL_BYTES) {
    throw new S3Error("InvalidRequest", { Reason: "Metadata is too large." });
  }

  const expires = headers.get("expires");
  let expiresAt: string | null = null;
  if (expires) {
    const ms = Date.parse(expires);
    if (Number.isNaN(ms)) throw new S3Error("InvalidArgument", { ArgumentName: "Expires" });
    expiresAt = new Date(ms).toISOString();
  }

  const contentEncoding = (headers.get("content-encoding") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value && value.toLowerCase() !== "aws-chunked")
    .join(", ");

  return {
    contentType: headers.get("content-type") ?? "application/octet-stream",
    cacheControl: headers.get("cache-control"),
    contentDisposition: headers.get("content-disposition"),
    contentEncoding: contentEncoding || null,
    contentLanguage: headers.get("content-language"),
    expiresAt,
    userMetadata,
  };
}

export function applyObjectMetadataHeaders(
  headers: Headers,
  object: {
    content_type: string;
    cache_control: string | null;
    content_disposition: string | null;
    content_encoding: string | null;
    content_language: string | null;
    expires_at: string | null;
    metadata_json: string;
  },
): void {
  headers.set("Content-Type", object.content_type);
  if (object.cache_control) headers.set("Cache-Control", object.cache_control);
  if (object.content_disposition) headers.set("Content-Disposition", object.content_disposition);
  if (object.content_encoding) headers.set("Content-Encoding", object.content_encoding);
  if (object.content_language) headers.set("Content-Language", object.content_language);
  if (object.expires_at) headers.set("Expires", new Date(object.expires_at).toUTCString());
  let metadata: Record<string, string> = {};
  try {
    metadata = JSON.parse(object.metadata_json) as Record<string, string>;
  } catch {
    metadata = {};
  }
  for (const [key, value] of Object.entries(metadata)) {
    headers.set(`x-amz-meta-${key}`, value);
  }
}
