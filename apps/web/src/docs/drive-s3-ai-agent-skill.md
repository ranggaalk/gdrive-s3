# DriveS3 Gateway Integration Skill

Use this skill when an application, script, backend service, CLI, or AI agent needs to integrate with this DriveS3 Gateway S3-compatible storage.

## What this gateway is

DriveS3 Gateway exposes an S3-compatible API backed by Google Drive. Applications should treat it like an S3 endpoint with these fixed rules:

- Use AWS Signature Version 4.
- Use path-style addressing.
- Use the configured endpoint: `{{S3_ENDPOINT}}`.
- Use the signing region: `{{S3_REGION}}`.
- Do not use virtual-hosted bucket subdomains.
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

## Object key guidance

- Use UTF-8 keys up to 1024 bytes.
- Preserve exact keys; do not normalize repeated slashes, dot segments, or case.
- Avoid leading slash; use `folder/file.ext`, not `/folder/file.ext`.
- Treat object keys as application data paths, not local filesystem paths.
- Store user-generated filenames safely; validate or prefix them to avoid collisions.

## Supported operations to prefer

- `PutObject` for single object upload.
- Multipart upload for large files if the SDK chooses it.
- `GetObject`, `HeadObject`, range reads, and conditional reads.
- `ListObjectsV2` with `Prefix` and continuation tokens.
- `DeleteObject` / bulk delete.
- Presigned SigV4 GET/PUT URLs with max expiry of seven days.

## Important limitations

Do not design against unsupported S3 features unless the gateway compatibility matrix says they are supported.

Avoid or explicitly handle:

- Virtual-hosted bucket URLs.
- ACLs and bucket policies.
- Object Lock and versioning.
- SSE-KMS and SigV4A.
- Cross-user copy workflows.
- Assuming Google Drive listing equals S3 listing.

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
- `NoSuchKey`: check exact object key; keys are case-sensitive.
- Slow or throttled Drive responses: retry with exponential backoff.
