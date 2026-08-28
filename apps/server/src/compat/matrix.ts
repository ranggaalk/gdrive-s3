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
  {
    feature: "Object versioning",
    status: "supported",
    verifiedBy: ["unit"],
    notes:
      "GET/PUT ?versioning, ListObjectVersions (?versions) dengan key/version-id " +
      "marker, ?versionId pada GET/HEAD/DELETE, delete marker, dan undelete. " +
      "Suspended menulis version id 'null' tanpa menghapus versi lama. " +
      "Bucket Disabled berperilaku persis seperti sebelumnya.",
  },
  {
    feature: "Object Lock / Legal Hold",
    status: "supported",
    verifiedBy: ["unit"],
    notes:
      "GET/PUT ?object-lock, ?retention, dan ?legal-hold; header lock saat PUT; " +
      "x-amz-bucket-object-lock-enabled saat CreateBucket. GOVERNANCE bisa " +
      "di-bypass hanya oleh pemilik bucket, COMPLIANCE tidak pernah bisa. " +
      "Retention hanya boleh diperpanjang. Versi terkunci dikecualikan dari " +
      "prune massal. Mengaktifkan Object Lock ikut menyalakan versioning.",
  },
  {
    feature: "ACL & Bucket Policy",
    status: "supported",
    verifiedBy: ["unit"],
    notes:
      "Canned ACL bucket/objek (x-amz-acl, GET/PUT ?acl) dan bucket policy " +
      "(GET/PUT/DELETE ?policy, GET ?policyStatus) dengan Principal/Action/" +
      "Resource/Condition. Explicit Deny mengalahkan Allow dan kepemilikan. " +
      "Request tanpa SigV4 dilayani bila ACL/policy mengizinkan publik; " +
      "matikan lewat S3_ALLOW_ANONYMOUS=false. Administrasi policy tetap " +
      "owner-only sehingga policy tidak bisa menulis ulang dirinya sendiri.",
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
      "Header dan presigned-query. Signing key diturunkan dari access key id + secret " +
      "yang sama dengan SigV4, jadi tidak ada material kredensial baru. Region set " +
      "wajib ditandatangani dan harus cocok dengan region gateway atau '*'. " +
      "Chunked upload signing SigV4A belum didukung.",
  },
  {
    feature: "PresignedPost (browser form POST)",
    status: "supported",
    verifiedBy: ["unit"],
    notes:
      "POST /{bucket} multipart/form-data dengan policy bertanda tangan. Setiap kondisi " +
      "policy ditegakkan dan setiap field yang dikirim wajib tercakup kondisi. " +
      "success_action_status dan success_action_redirect didukung; body di-stream, " +
      "tidak pernah dibuffer penuh.",
  },
  {
    feature: "CopyObject with byte range / cross-user",
    status: "supported",
    verifiedBy: ["unit"],
    notes:
      "UploadPartCopy dengan x-amz-copy-source-range, copy lintas pemilik bila " +
      "bucket policy/ACL mengizinkan, kondisi x-amz-copy-source-if-*, dan " +
      "?versionId pada sumber. Byte dibaca dengan token pemilik bucket sumber " +
      "dan ditulis dengan token pemilik bucket tujuan. Enkripsi tujuan " +
      "mengikuti aturan bucket tujuan, bukan sumber.",
  },
  {
    feature: "SSE-KMS / Server-side encryption",
    status: "supported",
    verifiedBy: ["unit"],
    notes:
      "SSE-S3 (AES256), SSE-KMS (aws:kms, CMK lokal, alias didukung), dan SSE-C. " +
      "Envelope encryption AES-256-CTR dengan data key per objek; CTR dipilih " +
      "agar Range GET tetap seekable. ETag tetap MD5 plaintext. Rotasi CMK " +
      "menyimpan material lama sehingga objek lama tetap terbaca. Default " +
      "per-bucket via ?encryption. Multipart SSE-C belum didukung.",
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
