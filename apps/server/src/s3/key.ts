// S3 object-key parsing and validation (AGENTS.md §13). Decode URL exactly
// once, never normalize paths, preserve repeated slashes/dot segments.

import { S3Error } from "./errors.ts";

export function decodeS3Path(pathname: string): { bucket: string | null; key: string | null } {
  // Leading slash belongs to HTTP path, not the bucket name.
  const raw = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (raw === "") return { bucket: null, key: null };

  const slash = raw.indexOf("/");
  const rawBucket = slash === -1 ? raw : raw.slice(0, slash);
  const rawKey = slash === -1 ? null : raw.slice(slash + 1);
  try {
    const bucket = decodeURIComponent(rawBucket);
    const key = rawKey === null ? null : decodeURIComponent(rawKey);
    return { bucket, key };
  } catch {
    throw new S3Error("InvalidRequest", { Reason: "Invalid percent encoding." });
  }
}

export function validateObjectKey(key: string, requireNonEmpty = true): void {
  if (requireNonEmpty && key === "") {
    throw new S3Error("InvalidRequest", { Reason: "Object key must not be empty." });
  }
  if (Buffer.byteLength(key, "utf8") > 1024) {
    throw new S3Error("InvalidRequest", { Reason: "Object key exceeds 1024 bytes." });
  }
  // No normalization by design: a//b, a/./b and a/b remain distinct.
}
