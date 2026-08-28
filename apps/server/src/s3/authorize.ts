// The bridge between an S3 request and AuthorizationService.
//
// Every data-plane handler resolves its bucket through here, so the ACL and
// policy checks cannot be forgotten in one operation and applied in another.
// It also keeps the two identities straight: who is *authorized* (possibly
// nobody) versus whose Drive token actually moves the bytes.

import type { AccessibleBucketRow } from "../db/repositories/buckets.ts";
import type { ObjectRow } from "../db/repositories/objects.ts";
import type { S3Action } from "../services/authorization-service.ts";
import { driveActor, type S3RequestContext } from "./context.ts";
import { S3Error } from "./errors.ts";

export interface AuthorizedBucket {
  bucket: AccessibleBucketRow;
  /** The object the action targets, when it names one and it exists. */
  object: ObjectRow | null;
  /** Whose Drive credentials to use for the storage call. */
  actorUserId: string;
}

/**
 * Resolve and authorize a bucket for this request.
 *
 * `NoSuchBucket` is deliberately what an unauthorized anonymous caller sees
 * when the bucket exists but grants them nothing, matching S3: telling an
 * anonymous stranger that a private bucket exists is itself a disclosure.
 * An authenticated caller who can see the bucket but lacks the specific
 * permission gets AccessDenied, which is the more useful answer.
 */
export function authorizeBucket(
  ctx: S3RequestContext,
  bucketName: string,
  action: S3Action,
  objectKey?: string,
): AuthorizedBucket {
  const bucket = ctx.app.authorization.resolveBucket({
    userId: ctx.userId,
    bucketName,
    action,
    objectKey,
    sourceIp: ctx.sourceIp,
    secureTransport: ctx.secureTransport,
  });
  if (!bucket) throw new S3Error("NoSuchBucket", { BucketName: bucketName });

  const object =
    objectKey === undefined
      ? null
      : ctx.app.repos.objects.findByKey(bucket.id, objectKey);

  const allowed = ctx.app.authorization.isAllowed({
    userId: ctx.userId,
    bucket,
    action,
    objectKey,
    object,
    sourceIp: ctx.sourceIp,
    secureTransport: ctx.secureTransport,
  });
  if (!allowed) {
    // Don't confirm a private bucket's existence to an anonymous caller.
    if (ctx.userId === null) throw new S3Error("NoSuchBucket", { BucketName: bucketName });
    throw new S3Error("AccessDenied");
  }

  return { bucket, object, actorUserId: driveActor(ctx, bucket) };
}

/**
 * Shared Drive membership check. Bucket bytes may live in a Shared Drive the
 * acting account must still be able to reach, which is a separate question
 * from whether the policy allows the operation.
 */
export async function verifyDriveAccess(
  ctx: S3RequestContext,
  authorized: AuthorizedBucket,
  requireWrite: boolean,
): Promise<void> {
  try {
    await ctx.app.bucketAccess.verifyActorAccess(
      authorized.actorUserId,
      authorized.bucket,
      requireWrite,
      ctx.signal ?? undefined,
    );
  } catch {
    throw new S3Error("AccessDenied");
  }
}
