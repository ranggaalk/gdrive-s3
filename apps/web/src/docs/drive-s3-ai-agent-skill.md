# DriveS3 Gateway Integration Skill

Use this skill when an application, script, backend service, CLI, or AI agent needs to integrate with this DriveS3 Gateway S3-compatible storage.

## What this gateway is

DriveS3 Gateway exposes an S3-compatible API backed by Google Drive. Applications should treat it like an S3 endpoint with these fixed rules:

- Use AWS Signature Version 4. SigV4A is also accepted, with the same credentials.
- Use path-style addressing.
- Use the configured endpoint: `{{S3_ENDPOINT}}`.
- Use the signing region: `{{S3_REGION}}`.
- Use path-style addressing unless the operator confirms this deployment has `S3_VIRTUAL_HOSTED_DOMAIN` set; virtual-hosted bucket subdomains are opt-in and off by default.
- Store credentials in a secret manager or environment variables, never in source code.
- SQLite is the namespace source of truth; applications must interact through the S3/API surface, not directly through Google Drive.

## Required inputs before coding

Ask the operator or user for:

1. `DRIVES3_ENDPOINT` — usually `{{S3_ENDPOINT}}`.
2. `DRIVES3_REGION` — usually `{{S3_REGION}}`.
3. `DRIVES3_BUCKET` — the target bucket name.
4. `DRIVES3_ACCESS_KEY_ID` — generated from the DriveS3 dashboard.
5. `DRIVES3_SECRET_ACCESS_KEY` — shown once when the key is created.

Recommended `.env` shape:

```env
DRIVES3_ENDPOINT={{S3_ENDPOINT}}
DRIVES3_REGION={{S3_REGION}}
DRIVES3_BUCKET=replace-with-bucket-name
DRIVES3_ACCESS_KEY_ID=replace-with-access-key-id
DRIVES3_SECRET_ACCESS_KEY=replace-with-secret-access-key
```

## JavaScript / TypeScript integration

Use AWS SDK v3 and force path-style addressing.

```ts
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";

export const s3 = new S3Client({
  endpoint: process.env.DRIVES3_ENDPOINT!,
  region: process.env.DRIVES3_REGION ?? "{{S3_REGION}}",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.DRIVES3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.DRIVES3_SECRET_ACCESS_KEY!,
  },
});

export async function uploadObject(key: string, body: Buffer | Uint8Array | string, contentType = "application/octet-stream") {
  await s3.send(new PutObjectCommand({
    Bucket: process.env.DRIVES3_BUCKET!,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
}

export async function listObjects(prefix = "") {
  const result = await s3.send(new ListObjectsV2Command({
    Bucket: process.env.DRIVES3_BUCKET!,
    Prefix: prefix,
  }));
  return result.Contents ?? [];
}

export async function downloadObject(key: string) {
  const result = await s3.send(new GetObjectCommand({
    Bucket: process.env.DRIVES3_BUCKET!,
    Key: key,
  }));
  return result.Body;
}

export async function deleteObject(key: string) {
  await s3.send(new DeleteObjectCommand({
    Bucket: process.env.DRIVES3_BUCKET!,
    Key: key,
  }));
}
```

## Python integration

Use boto3 with `addressing_style = path`.

```py
import os
import boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["DRIVES3_ENDPOINT"],
    region_name=os.environ.get("DRIVES3_REGION", "{{S3_REGION}}"),
    aws_access_key_id=os.environ["DRIVES3_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["DRIVES3_SECRET_ACCESS_KEY"],
    config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
)

bucket = os.environ["DRIVES3_BUCKET"]

s3.put_object(Bucket=bucket, Key="hello.txt", Body=b"hello", ContentType="text/plain")
print(s3.list_objects_v2(Bucket=bucket, Prefix=""))
```

## AWS CLI smoke test

```bash
aws configure set aws_access_key_id "$DRIVES3_ACCESS_KEY_ID" --profile drives3
aws configure set aws_secret_access_key "$DRIVES3_SECRET_ACCESS_KEY" --profile drives3
aws configure set region "$DRIVES3_REGION" --profile drives3
aws configure set s3.addressing_style path --profile drives3

aws --profile drives3 --endpoint-url "$DRIVES3_ENDPOINT" s3api list-buckets
aws --profile drives3 --endpoint-url "$DRIVES3_ENDPOINT" s3 cp ./local.txt "s3://$DRIVES3_BUCKET/local.txt"
aws --profile drives3 --endpoint-url "$DRIVES3_ENDPOINT" s3 ls "s3://$DRIVES3_BUCKET/"
```

## Versioning, encryption, and access control

These are supported; the snippets below are the shapes to generate.

Turn on versioning and read an old version back:

```ts
import { PutBucketVersioningCommand, ListObjectVersionsCommand, GetObjectCommand } from "@aws-sdk/client-s3";

await s3.send(new PutBucketVersioningCommand({
  Bucket: bucket,
  VersioningConfiguration: { Status: "Enabled" },
}));

const versions = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: "notes/" }));
const previous = versions.Versions?.find((v) => !v.IsLatest);
if (previous) {
  await s3.send(new GetObjectCommand({ Bucket: bucket, Key: previous.Key!, VersionId: previous.VersionId! }));
}
```

A `DeleteObject` on a versioned bucket writes a delete marker rather than
removing bytes. The DELETE response carries `x-amz-delete-marker: true` and the
marker's `x-amz-version-id`; a later GET of that key returns 404. Keep the
marker's version id — deleting it is how you undelete the object.

Encrypt on write:

```ts
// SSE-S3 — the gateway manages the key.
await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ServerSideEncryption: "AES256" }));

// SSE-KMS — name a CMK created on the dashboard Security page.
await s3.send(new PutObjectCommand({
  Bucket: bucket, Key: key, Body: body,
  ServerSideEncryption: "aws:kms",
  SSEKMSKeyId: process.env.DRIVES3_KMS_KEY_ID!,
}));
```

Set a bucket default with `PutBucketEncryption` instead, and every write to that
bucket is encrypted without the caller passing headers.

Grant read access to another user, or to the public:

```ts
import { PutBucketPolicyCommand } from "@aws-sdk/client-s3";

await s3.send(new PutBucketPolicyCommand({
  Bucket: bucket,
  Policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { AWS: "arn:aws:iam:::user/teammate@example.com" },
      Action: ["s3:GetObject", "s3:ListBucket"],
      Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
    }],
  }),
}));
```

Use `Principal: "*"` for anonymous read. Prefer a policy over a canned ACL when
the rule needs a condition (`IpAddress` on `aws:SourceIp`, `StringEquals` on
`aws:username`, `Bool` on `aws:SecureTransport`).

## Object key guidance

- Use UTF-8 keys up to 1024 bytes.
- Preserve exact keys; do not normalize repeated slashes, dot segments, or case.
- Avoid leading slash; use `folder/file.ext`, not `/folder/file.ext`.
- Treat object keys as application data paths, not local filesystem paths.
- Store user-generated filenames safely; validate or prefix them to avoid collisions.

## Supported operations

The dashboard Overview page carries the authoritative compatibility matrix: a
row cannot be marked supported without naming the test that proves it. Check it
before designing against anything not listed here.

Core data plane:

- `PutObject` for single object upload.
- Multipart upload for large files, including `UploadPartCopy`.
- `GetObject`, `HeadObject`, range reads (`206`), and conditional reads
  (`If-Match`, `If-None-Match`, `If-Modified-Since`).
- `ListObjectsV2` with `Prefix`, `Delimiter`, and continuation tokens;
  `ListObjects` (v1) also works.
- `DeleteObject` and bulk delete.
- `CopyObject`, including byte-range copies and copies between different
  owners' buckets when a policy or ACL permits it.

Authentication and URLs:

- SigV4 (header and presigned query).
- SigV4A (`AWS4-ECDSA-P256-SHA256`), header and presigned-query forms, using the
  same access key id and secret as SigV4 — no separate credential material.
- Presigned GET/PUT/HEAD URLs, expiry capped at seven days.
- PresignedPost: browser `multipart/form-data` `POST /{bucket}` with a signed
  policy, including `success_action_status` and `success_action_redirect`.

Object management:

- Versioning: `GET/PUT ?versioning`, `ListObjectVersions` (`?versions`) with key
  and version-id markers, `?versionId` on GET/HEAD/DELETE, delete markers, and
  undelete.
- Object Lock and Legal Hold: `?object-lock`, `?retention`, `?legal-hold`, and
  the matching PUT headers.
- Server-side encryption: SSE-S3 (`AES256`), SSE-KMS (`aws:kms` with local CMKs
  and aliases), and SSE-C. Per-bucket defaults via `?encryption`.
- Access control: canned ACLs (`x-amz-acl`, `GET/PUT ?acl`) and bucket policies
  (`GET/PUT/DELETE ?policy`, `GET ?policyStatus`) with Principal, Action,
  Resource, and Condition.

## Behaviour to design around

These are real constraints, not missing features. Handle them explicitly:

- **Virtual-hosted URLs are opt-in.** Path-style always works. Only use
  `{bucket}.{domain}` if the operator confirms `S3_VIRTUAL_HOSTED_DOMAIN` is set
  for this deployment.
- **SigV4A does not sign chunked uploads.** A `STREAMING-*` payload hash is
  rejected under SigV4A; use SigV4 for chunked/streaming signed uploads.
- **SSE-C does not cover multipart.** Use SSE-S3 or SSE-KMS for large objects
  that need encryption, or upload them as a single part.
- **An SSE object's ETag is the plaintext MD5**, which is a deliberate
  divergence from AWS (AWS returns a non-MD5 ETag for encrypted objects). Do not
  infer from the ETag whether an object is encrypted; read
  `x-amz-server-side-encryption` instead.
- **An explicit `Deny` in a bucket policy beats any `Allow`, including
  ownership.** Policy administration itself stays owner-only, so a policy cannot
  rewrite or lock out its own administrator.
- **Anonymous requests are served when an ACL or policy allows the public.** The
  operator can turn this off entirely with `S3_ALLOW_ANONYMOUS=false`, so never
  make a public object the only path to data your application needs.
- **Retention may only be extended, never shortened.** `GOVERNANCE` mode can be
  bypassed only by the bucket owner; `COMPLIANCE` never can.
- **A Drive folder listing is not an S3 listing.** SQLite is the namespace
  source of truth. Never reconcile against Google Drive directly.

## Security requirements

- Never commit access keys or secrets.
- Never log `Authorization`, `X-Amz-Signature`, secret keys, session cookies, or presigned URLs.
- Use one access key per application/environment.
- Rotate or revoke keys from the dashboard when compromised or no longer used.
- Use HTTPS in production.
- Keep bucket permissions least-privilege: Viewer for read-only, Editor for write access.

## Agent checklist before returning code

When you generate integration code, verify that:

- The S3 client sets `endpoint` to `{{S3_ENDPOINT}}` or reads it from config.
- The S3 client sets `region` to `{{S3_REGION}}` or reads it from config.
- Path-style addressing is enabled.
- Credentials come from env/secret manager, not literals.
- The bucket name is configurable.
- Errors from S3 calls are handled and surfaced to the application.
- Uploads set a useful `ContentType` when known.
- Tests or smoke commands are provided.

## Minimal troubleshooting

- `SignatureDoesNotMatch`: check endpoint, region, clock skew, path-style setting, and whether the exact request body was signed.
- `AccessDenied`: check DriveS3 credential status and bucket membership.
- `NoSuchBucket`: check bucket name and whether the credential owner can access it.
- `NoSuchKey`: check exact object key; keys are case-sensitive. On a versioned
  bucket, also check whether the latest version is a delete marker.
- `InvalidRequest` on a GET of an encrypted object: the object is SSE-C and the
  customer key headers were not sent, or were sent for a plaintext object.
- `AccessDenied` on a delete that used to work: the version may be under
  Object Lock retention or a legal hold.
- `AccessDenied` despite owning the bucket: an explicit `Deny` statement in the
  bucket policy outranks ownership.
- Slow or throttled Drive responses: retry with exponential backoff. The
  dashboard API Quota page shows the live Google-reported limits.
