// Resolving the per-bucket write settings that apply to every object write.
//
// Versioning, default encryption, and Object Lock are bucket properties, so
// they must apply no matter which door a write comes through — the S3 data
// plane, a browser form, the dashboard, or a copy. Deriving them in each
// handler is how the dashboard ended up silently ignoring all three, which on
// a versioned bucket meant an overwrite destroyed the previous version's
// bytes. There is one implementation now, and callers pass their request
// headers only if they have any.

import type { AppContext } from "../context.ts";
import type { AccessibleBucketRow } from "../db/repositories/buckets.ts";
import { newVersionId } from "../db/repositories/object-versions.ts";
import { resolveDefaultRetention, parseLockHeaders } from "../s3/object-lock.ts";
import { parseSseRequest, type SseRequest } from "../s3/sse.ts";
import { S3Error } from "../s3/errors.ts";
import { EncryptionService, type EncryptionPlan } from "./encryption-service.ts";

export interface ObjectWriteOptions {
  versioning: "Disabled" | "Enabled" | "Suspended";
  versionId: string;
  encryption: EncryptionPlan | null;
  lock: { mode: string | null; retainUntil: string | null; legalHold: boolean } | null;
}

/**
 * Work out how a write to this bucket must be stored.
 *
 * `headers` is optional: callers with no S3 request (the dashboard, the
 * control-plane copy) simply get the bucket's own defaults.
 */
export function resolveWriteOptions(
  app: AppContext,
  bucket: AccessibleBucketRow,
  headers?: Headers,
): ObjectWriteOptions {
  const sseRequest: SseRequest = headers ? parseSseRequest(headers) : { kind: "none" };
  const requestedLock = headers
    ? parseLockHeaders(headers)
    : { mode: null, retainUntil: null, legalHold: false };

  if (!bucket.object_lock_enabled && (requestedLock.mode || requestedLock.legalHold)) {
    throw new S3Error("InvalidRequest", {
      Reason: "Object Lock is not enabled for this bucket.",
    });
  }

  const defaultRetention = requestedLock.mode
    ? null
    : resolveDefaultRetention(bucket.object_lock_default_json);

  return {
    versioning: bucket.versioning,
    // Suspended writes the literal 'null' id, as S3 does.
    versionId: bucket.versioning === "Enabled" ? newVersionId() : "null",
    encryption: new EncryptionService(app).planFor({
      // The bytes land in the bucket owner's Drive, so their key catalogue
      // backs the encryption regardless of who is writing.
      ownerUserId: bucket.user_id,
      bucket,
      request: sseRequest,
    }),
    lock: bucket.object_lock_enabled
      ? {
          mode: requestedLock.mode ?? defaultRetention?.mode ?? null,
          retainUntil: requestedLock.retainUntil ?? defaultRetention?.retainUntil ?? null,
          legalHold: requestedLock.legalHold,
        }
      : null,
  };
}
