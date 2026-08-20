// RFC 7232-style conditional GET/HEAD evaluation for S3 metadata.

import type { ObjectRow } from "../db/repositories/objects.ts";
import { quoteEtag } from "./etag.ts";
import { S3Error } from "./errors.ts";

export type ConditionalResult = "proceed" | "not-modified";

export function evaluateConditions(
  headers: Headers,
  object: Pick<ObjectRow, "etag" | "last_modified_at">,
): ConditionalResult {
  const etag = quoteEtag(object.etag);
  const modifiedMs = Date.parse(object.last_modified_at);

  // If-Match takes precedence over If-Unmodified-Since.
  const ifMatch = headers.get("if-match");
  if (ifMatch !== null) {
    if (!etagListMatches(ifMatch, etag, true)) throw new S3Error("PreconditionFailed");
  } else {
    const ifUnmodified = headers.get("if-unmodified-since");
    if (ifUnmodified) {
      const t = Date.parse(ifUnmodified);
      if (!Number.isNaN(t) && modifiedMs > t) throw new S3Error("PreconditionFailed");
    }
  }

  // If-None-Match takes precedence over If-Modified-Since.
  const ifNoneMatch = headers.get("if-none-match");
  if (ifNoneMatch !== null) {
    if (etagListMatches(ifNoneMatch, etag, false)) return "not-modified";
  } else {
    const ifModified = headers.get("if-modified-since");
    if (ifModified) {
      const t = Date.parse(ifModified);
      // HTTP dates only have second precision.
      if (!Number.isNaN(t) && Math.floor(modifiedMs / 1000) <= Math.floor(t / 1000)) {
        return "not-modified";
      }
    }
  }
  return "proceed";
}

function etagListMatches(header: string, current: string, strong: boolean): boolean {
  if (header.trim() === "*") return true;
  return header.split(",").some((raw) => {
    const token = raw.trim();
    if (strong && token.startsWith("W/")) return false;
    const normalized = token.startsWith("W/") ? token.slice(2) : token;
    return normalized === current;
  });
}
