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
    notes: "Virtual-hosted style tetap tidak didukung.",
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
    notes: "Diverifikasi via scripts/compat-aws-cli.sh (create-bucket, cp, ls, rm, delete-bucket).",
  },
  {
    feature: "rclone compatibility smoke",
    status: "supported",
    verifiedBy: ["rclone"],
    notes: "Diverifikasi via scripts/compat-rclone.sh (create, upload, ListObjects v1, nested/recursive list, download, delete).",
  },
  {
    feature: "MinIO mc compatibility smoke",
    status: "supported",
    verifiedBy: ["mc"],
    notes: "Diverifikasi via scripts/compat-mc.sh (create, signed streaming upload, list, download, delete) dengan RELEASE.2025-08-13T08-35-41Z.",
  },
  { feature: "Object versioning", status: "unsupported" },
  { feature: "Object Lock / Legal Hold", status: "unsupported" },
  { feature: "ACL & Bucket Policy", status: "unsupported" },
  { feature: "Virtual-hosted style bucket endpoint", status: "unsupported" },
  { feature: "SigV4A / PresignedPost (form)", status: "unsupported" },
  { feature: "CopyObject with byte range / cross-user", status: "unsupported" },
  { feature: "SSE-KMS / Server-side encryption", status: "unsupported" },
];

export function compatMatrix(): CompatRow[] {
  return COMPAT_MATRIX.map((row) => ({
    feature: row.feature,
    status: row.status,
    verifiedBy: row.verifiedBy ? [...row.verifiedBy] : undefined,
    notes: row.notes,
  }));
}
