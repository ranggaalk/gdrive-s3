// The single place that decides whether an S3 data-plane request is allowed.
//
// Before ACLs there was one rule: you can touch a bucket if you own it or are
// a member of it. That is still the backbone, but two more sources now feed in
// — the bucket policy and the canned ACL — and a caller may now be anonymous.
// Spreading that across the operation handlers would mean four places to get
// it right, so every path funnels through here.
//
// Order of resolution, strictest first:
//   1. An explicit Deny in the bucket policy stops everything, owner included.
//      This is what makes a policy a usable guardrail.
//   2. The owner and members keep the access their role implies.
//   3. An Allow in the bucket policy.
//   4. The canned ACL on the object, then the bucket.
//   5. Otherwise: denied.

import type { AccessibleBucketRow, BucketsRepository } from "../db/repositories/buckets.ts";
import type { ObjectRow } from "../db/repositories/objects.ts";
import type { BucketPoliciesRepository } from "../db/repositories/bucket-policies.ts";
import type { UsersRepository } from "../db/repositories/users.ts";
import type { BucketMembersRepository } from "../db/repositories/bucket-members.ts";
import type { ObjectsRepository } from "../db/repositories/objects.ts";
import {
  aclGrantsAuthenticatedRead,
  aclGrantsPublicRead,
  aclGrantsPublicWrite,
} from "../s3/acl.ts";
import {
  bucketArn,
  evaluatePolicy,
  objectArn,
  parseBucketPolicy,
  policyIsPublic,
  type BucketPolicy,
  type PolicyContext,
  type PolicyPrincipal,
} from "../s3/policy.ts";

/** What the caller is trying to do, in S3 action terms. */
export type S3Action =
  | "s3:GetObject"
  | "s3:PutObject"
  | "s3:DeleteObject"
  | "s3:ListBucket"
  | "s3:GetBucketLocation"
  | "s3:GetBucketPolicy"
  | "s3:PutBucketPolicy"
  | "s3:GetBucketAcl"
  | "s3:PutBucketAcl"
  | "s3:GetObjectAcl"
  | "s3:PutObjectAcl"
  | "s3:AbortMultipartUpload"
  | "s3:ListMultipartUploadParts";

const WRITE_ACTIONS = new Set<S3Action>([
  "s3:PutObject",
  "s3:DeleteObject",
  "s3:PutBucketPolicy",
  "s3:PutBucketAcl",
  "s3:PutObjectAcl",
  "s3:AbortMultipartUpload",
]);

/** Actions only an owner may ever perform, whatever a policy or ACL says.
 *  Letting a policy grant these would let a policy rewrite itself. */
const OWNER_ONLY_ACTIONS = new Set<S3Action>([
  "s3:GetBucketPolicy",
  "s3:PutBucketPolicy",
  "s3:PutBucketAcl",
]);

/** Any grant among these makes a bucket *visible* to an authenticated caller,
 *  which is what separates a 403 from a 404. */
const VISIBILITY_PROBE_ACTIONS: S3Action[] = [
  "s3:GetObject",
  "s3:PutObject",
  "s3:DeleteObject",
  "s3:ListBucket",
];

export interface AuthorizationRequest {
  /** Null when the request carried no credentials. */
  userId: string | null;
  bucket: AccessibleBucketRow;
  action: S3Action;
  /** Present for object-scoped actions. */
  objectKey?: string;
  object?: ObjectRow | null;
  sourceIp: string | null;
  secureTransport: boolean;
}

export class AuthorizationService {
  constructor(
    private readonly buckets: BucketsRepository,
    private readonly policies: BucketPoliciesRepository,
    private readonly users: UsersRepository,
    private readonly members: BucketMembersRepository,
    private readonly objects: ObjectsRepository,
  ) {}

  /** The stored policy for a bucket, or null. A stored document that no longer
   *  parses is treated as absent rather than throwing: a corrupt row must not
   *  make the bucket unreachable, and "absent" is the closed default. */
  policyFor(bucketId: string): BucketPolicy | null {
    const row = this.policies.find(bucketId);
    if (!row) return null;
    try {
      return parseBucketPolicy(row.policy_json);
    } catch {
      return null;
    }
  }

  principalFor(userId: string | null): PolicyPrincipal {
    if (!userId) return { userId: null, email: null };
    const user = this.users.findById(userId);
    return { userId, email: user?.email?.toLowerCase() ?? null };
  }

  /** Is this bucket reachable by the anonymous public at all? Drives
   *  GetBucketPolicyStatus and the dashboard's "public" badge. */
  isPublic(bucket: AccessibleBucketRow): boolean {
    if (aclGrantsPublicRead(bucket.acl) || aclGrantsPublicWrite(bucket.acl)) return true;
    const policy = this.policyFor(bucket.id);
    return policy ? policyIsPublic(policy) : false;
  }

  /**
   * Resolve a bucket name for a caller.
   *
   * Bucket names are unique per user here, not globally as in S3, so an
   * anonymous request cannot map a name to an owner on its own. For those we
   * gather every active bucket with the name and keep the ones that actually
   * grant the requested access. Exactly one match is required — with two
   * public buckets sharing a name the request is genuinely ambiguous, and
   * guessing could serve the wrong owner's bytes.
   */
  resolveBucket(input: {
    userId: string | null;
    bucketName: string;
    action: S3Action;
    objectKey?: string;
    sourceIp: string | null;
    secureTransport: boolean;
  }): AccessibleBucketRow | null {
    if (input.userId) {
      const direct = this.buckets.findAccessibleByName(input.userId, input.bucketName);
      if (direct) return direct;
      // Not owned and not a member — but a bucket policy can still name this
      // user, so fall through to the same candidate scan anonymous uses.
    }
    const candidates = this.buckets.listByName(input.bucketName);
    if (candidates.length === 0) return null;

    const probe = (bucket: AccessibleBucketRow, action: S3Action): boolean =>
      this.isAllowed({
        userId: input.userId,
        bucket,
        action,
        objectKey: input.objectKey,
        // The object's own ACL can be what admits this request, so it has to
        // be loaded before the decision, not after.
        object:
          input.objectKey === undefined
            ? null
            : this.objects.findByKey(bucket.id, input.objectKey),
        sourceIp: input.sourceIp,
        secureTransport: input.secureTransport,
      });

    let reachable = candidates.filter((bucket) => probe(bucket, input.action));

    // An authenticated caller who holds *some* grant on the bucket should be
    // told the action was denied, not that the bucket does not exist. So if
    // the requested action found nothing, fall back to a visibility probe and
    // let isAllowed produce the AccessDenied. Anonymous callers deliberately
    // skip this: for them, "not permitted" and "does not exist" must look the
    // same, or the response becomes an existence oracle.
    if (reachable.length === 0 && input.userId !== null) {
      reachable = candidates.filter((bucket) =>
        VISIBILITY_PROBE_ACTIONS.some((action) => probe(bucket, action)),
      );
    }

    return reachable.length === 1 ? reachable[0]! : null;
  }

  /**
   * The decision. Note that the object row is looked up by the caller and
   * passed in, so this stays free of I/O beyond the policy and user lookups.
   */
  isAllowed(request: AuthorizationRequest): boolean {
    const { bucket, action } = request;
    const isOwner = request.userId !== null && bucket.user_id === request.userId;
    const principal = this.principalFor(request.userId);
    const context: PolicyContext = {
      sourceIp: request.sourceIp,
      secureTransport: request.secureTransport,
    };

    const policy = this.policyFor(bucket.id);
    if (policy) {
      const resource =
        request.objectKey === undefined
          ? bucketArn(bucket.name)
          : objectArn(bucket.name, request.objectKey);
      const decision = evaluatePolicy({
        policy,
        principal,
        action,
        resourceArn: resource,
        context,
      });
      // An explicit Deny outranks ownership: that is the whole point of being
      // able to write a guardrail policy against your own bucket.
      if (decision === "deny") return false;
      if (decision === "allow" && !OWNER_ONLY_ACTIONS.has(action)) return true;
    }

    if (isOwner) return true;

    // A member's role decides, exactly as before ACLs existed. The role is
    // read from bucket_members rather than from the row, because a row may
    // have been built by a query with no caller to resolve it against
    // (`listByName`), and trusting its placeholder would hand every
    // authenticated caller a member's rights.
    if (request.userId !== null) {
      const membership = this.members.find(bucket.id, request.userId);
      if (membership?.role === "editor") return true;
      if (membership?.role === "viewer" && !WRITE_ACTIONS.has(action)) return true;
    }

    if (OWNER_ONLY_ACTIONS.has(action)) return false;

    return this.aclAllows(request, action);
  }

  /** The canned ACL fallback: the object's own ACL first, then the bucket's. */
  private aclAllows(request: AuthorizationRequest, action: S3Action): boolean {
    const authenticated = request.userId !== null;
    const writing = WRITE_ACTIONS.has(action);

    const grants = (acl: string): boolean =>
      writing
        ? aclGrantsPublicWrite(acl)
        : aclGrantsPublicRead(acl) || (authenticated && aclGrantsAuthenticatedRead(acl));

    // Reading an object consults the object's ACL; a public object in an
    // otherwise private bucket is a shape S3 supports and people rely on.
    if (request.object && !writing && grants(request.object.acl)) return true;

    // Bucket-scoped reads (ListBucket) and every write fall to the bucket ACL.
    return grants(request.bucket.acl);
  }
}
