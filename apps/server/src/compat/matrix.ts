// S3 compatibility matrix, backed by evidence — no row may be marked
// "supported" without at least one verifiedBy entry. Enforced by
// `tests/unit/compat-matrix.test.ts` so we cannot claim coverage the tests
// have not proven (AGENTS.md §28, §30).

export type CompatStatus = "supported" | "unsupported" | "untested";
export type CompatSource = "aws-sdk" | "aws-cli" | "rclone" | "mc" | "unit";

export interface CompatRow {
  feature: string;
  status: CompatStatus;
  verifiedBy?: CompatSource[];
  notes?: string;
}

/**
 * Ordered, immutable list. The order carries meaning in the UI — core
 * data-plane operations first, then multipart/copy, then presigned, then the
 * explicit "not supported" rows. Extend by appending, not reordering.
 */
export const COMPAT_MATRIX: readonly CompatRow[] = [
  {
    feature: "Path-style endpoint",
    status: "supported",
    verifiedBy: ["aws-sdk"],
  },
  { feature: "AWS SigV4 header (data plane)", status: "supported", verifiedBy: ["aws-sdk"] },
  { feature: "ListBuckets", status: "supported", verifiedBy: ["aws-sdk"] },
  { feature: "CreateBucket / DeleteBucket / HeadBucket", status: "supported", verifiedBy: ["aws-sdk"] },
  { feature: "PutObject / GetObject / HeadObject / DeleteObject", status: "supported", verifiedBy: ["aws-sdk"] },
  { feature: "ListObjectsV2 (prefix, delimiter, continuation)", status: "supported", verifiedBy: ["aws-sdk"] },
  { feature: "Range GET (206 partial content)", status: "supported", verifiedBy: ["aws-sdk"] },
  {
    feature: "Conditional GET (If-Match / If-None-Match / If-Modified-Since)",
    status: "supported",
    verifiedBy: ["aws-sdk"],
  },
  {
    feature: "Multipart Upload (Create/UploadPart/Complete/Abort/List)",
    status: "supported",
    verifiedBy: ["aws-sdk"],
  },
  {
    feature: "CopyObject (same user, COPY / REPLACE metadata)",
    status: "supported",
    verifiedBy: ["aws-sdk"],
  },
  {
    feature: "Presigned URL (SigV4 query, GET/PUT/HEAD)",
    status: "supported",
    verifiedBy: ["aws-sdk"],
  },
  {
    feature: "AWS CLI compatibility smoke",
    status: "supported",
    verifiedBy: ["aws-cli"],
    notes: "Verified by scripts/compat-aws-cli.sh (create-bucket, cp, ls, rm, delete-bucket).",
  },
  {
    feature: "rclone compatibility smoke",
    status: "supported",
    verifiedBy: ["rclone"],
    notes: "Verified by scripts/compat-rclone.sh (create, upload, ListObjects v1, nested and recursive list, download, delete).",
  },
  {
    feature: "MinIO mc compatibility smoke",
    status: "supported",
    verifiedBy: ["mc"],
    notes: "Verified by scripts/compat-mc.sh (create, signed streaming upload, list, download, delete) against RELEASE.2025-08-13T08-35-41Z.",
  },
  {
    feature: "Object versioning",
    status: "supported",
    verifiedBy: ["unit"],
    notes:
      "GET/PUT ?versioning, ListObjectVersions (?versions) with key and version-id " +
      "markers, ?versionId on GET/HEAD/DELETE, delete markers, and undelete. " +
      "Suspended writes the 'null' version id without discarding existing " +
      "versions. A Disabled bucket behaves exactly as it did before.",
  },
  {
    feature: "Object Lock / Legal Hold",
    status: "supported",
    verifiedBy: ["unit"],
    notes:
      "GET/PUT ?object-lock, ?retention, and ?legal-hold; lock headers on PUT; " +
      "x-amz-bucket-object-lock-enabled on CreateBucket. GOVERNANCE can be " +
      "bypassed only by the bucket owner, COMPLIANCE never. Retention may only " +
      "be extended. Locked versions are excluded from bulk pruning. Enabling " +
      "Object Lock also enables versioning.",
  },
  {
    feature: "ACL & Bucket Policy",
    status: "supported",
    verifiedBy: ["unit"],
    notes:
      "Canned bucket and object ACLs (x-amz-acl, GET/PUT ?acl) and bucket policies " +
      "(GET/PUT/DELETE ?policy, GET ?policyStatus) with Principal/Action/" +
      "Resource/Condition. An explicit Deny beats any Allow and ownership. " +
      "Unsigned requests are served when an ACL or policy allows the public; " +
      "disable with S3_ALLOW_ANONYMOUS=false. Policy administration stays " +
      "owner-only, so a policy cannot rewrite itself.",
  },
  {
    feature: "Virtual-hosted style bucket endpoint",
    status: "supported",
    verifiedBy: ["unit"],
    notes:
      "Opt-in via S3_VIRTUAL_HOSTED_DOMAIN; disabled (path-style only) unless set. " +
      "{bucket}.{domain} resolves the bucket from Host, path-style keeps working unchanged.",
  },
  {
    feature: "SigV4A (AWS4-ECDSA-P256-SHA256)",
    status: "supported",
    verifiedBy: ["unit"],
    notes:
      "Header and presigned-query forms. The signing key derives from the same " +
      "access key id and secret as SigV4, so no new credential material is " +
      "stored. The region set must be signed and must match the gateway region " +
      "or '*'. SigV4A chunked upload signing is not supported.",
  },
  {
    feature: "PresignedPost (browser form POST)",
    status: "supported",
    verifiedBy: ["unit"],
    notes:
      "POST /{bucket} multipart/form-data with a signed policy. Every policy " +
      "condition is enforced and every submitted field must be covered by one. " +
      "success_action_status and success_action_redirect are supported; the body " +
      "is streamed and never fully buffered.",
  },
  {
    feature: "CopyObject with byte range / cross-user",
    status: "supported",
    verifiedBy: ["unit"],
    notes:
      "UploadPartCopy with x-amz-copy-source-range, copies across owners when a " +
      "bucket policy or ACL allows it, x-amz-copy-source-if-* conditions, and " +
      "?versionId on the source. Bytes are read with the source bucket owner's " +
      "token and written with the target owner's. The target's encryption " +
      "follows the target bucket's rules, not the source's.",
  },
  {
    feature: "SSE-KMS / Server-side encryption",
    status: "supported",
    verifiedBy: ["unit"],
    notes:
      "SSE-S3 (AES256), SSE-KMS (aws:kms, local CMKs, aliases supported), and " +
      "SSE-C. Envelope encryption with AES-256-CTR and a per-object data key; " +
      "CTR is chosen so Range GET stays seekable. The ETag remains the plaintext " +
      "MD5. Rotating a CMK retains the old key material so existing objects stay " +
      "readable. Per-bucket defaults via ?encryption. SSE-C multipart is not supported.",
  },
];

export function compatMatrix(): CompatRow[] {
  return COMPAT_MATRIX.map((row) => ({
    feature: row.feature,
    status: row.status,
    verifiedBy: row.verifiedBy ? [...row.verifiedBy] : undefined,
    notes: row.notes,
  }));
}
