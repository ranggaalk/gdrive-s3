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

/**
 * Extracts the bucket name from a virtual-hosted-style Host header
 * (`{bucket}.{virtualHostedDomain}`), or null if the request is not
 * addressed that way (path-style, or Host doesn't match the configured
 * domain). Disabled entirely when virtualHostedDomain is "".
 */
export function resolveVirtualHostedBucket(
  hostHeader: string | null,
  virtualHostedDomain: string,
): string | null {
  if (!virtualHostedDomain || !hostHeader) return null;
  const host = hostHeader.split(":")[0]!.toLowerCase();
  const suffix = `.${virtualHostedDomain}`;
  if (!host.endsWith(suffix)) return null;
  const bucket = host.slice(0, -suffix.length);
  return bucket === "" ? null : bucket;
}

/** Decodes the path as an object key only, for virtual-hosted-style requests
 * where the bucket comes from the Host header instead of the first path
 * segment. "/" (or "") means bucket-level, same convention as decodeS3Path. */
export function decodeVirtualHostedKey(pathname: string): string | null {
  const raw = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (raw === "") return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new S3Error("InvalidRequest", { Reason: "Invalid percent encoding." });
  }
}

/** Resolves {bucket, key} for either addressing style, preferring
 * virtual-hosted when the Host header matches the configured domain. */
export function resolveS3Path(
  pathname: string,
  hostHeader: string | null,
  virtualHostedDomain: string,
): { bucket: string | null; key: string | null } {
  const virtualBucket = resolveVirtualHostedBucket(hostHeader, virtualHostedDomain);
  if (virtualBucket === null) return decodeS3Path(pathname);
  return { bucket: virtualBucket, key: decodeVirtualHostedKey(pathname) };
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
