import type { ObjectRow } from "../db/repositories/objects.ts";
import { applyObjectMetadataHeaders } from "../s3/metadata.ts";

const SAFE_EXACT = new Set([
  "application/pdf",
  "application/json",
  "text/plain",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
]);

export function isPreviewableContentType(contentType: string): boolean {
  const mime = contentType.split(";", 1)[0]!.trim().toLowerCase();
  return (
    SAFE_EXACT.has(mime) ||
    mime.startsWith("audio/") ||
    mime.startsWith("video/")
  );
}

export function objectFilename(key: string): string {
  const segments = key.split("/");
  const filename = segments[segments.length - 1] || "download";
  return filename.replace(/[\x00-\x1F\x7F]/g, "_");
}

export function contentDisposition(disposition: "inline" | "attachment", key: string): string {
  const filename = objectFilename(key);
  const fallback = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_") || "download";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}

export function objectResponseHeaders(
  object: ObjectRow,
  input: {
    contentLength: number;
    contentRange?: string | null;
    disposition: "inline" | "attachment";
  },
): Headers {
  const headers = new Headers({
    ETag: `"${object.etag}"`,
    "Last-Modified": new Date(object.last_modified_at).toUTCString(),
    "Accept-Ranges": "bytes",
    "Content-Length": String(input.contentLength),
    "Content-Disposition": contentDisposition(input.disposition, object.object_key),
    "X-Content-Type-Options": "nosniff",
  });
  applyObjectMetadataHeaders(headers, object);
  // Browser-facing routes choose their own cache and presentation policy;
  // untrusted stored headers must not override it.
  headers.delete("Cache-Control");
  headers.delete("Expires");
  headers.delete("Content-Encoding");
  headers.forEach((_value, name) => {
    if (name.toLowerCase().startsWith("x-amz-meta-")) headers.delete(name);
  });
  headers.set("Content-Disposition", contentDisposition(input.disposition, object.object_key));
  if (input.contentRange) headers.set("Content-Range", input.contentRange);
  return headers;
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
