// Load-test scenarios. Each scenario returns an operation closure; the runner
// controls concurrency and duration uniformly. Every closure performs one
// user-visible S3 operation (except multipart, where one complete lifecycle is
// the operation).

import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

export type ScenarioName = "put" | "get" | "list" | "multipart";
export type LoadOperation = () => Promise<void>;

export async function buildScenario(
  name: ScenarioName,
  client: S3Client,
  bucket: string,
): Promise<LoadOperation> {
  switch (name) {
    case "put":
      return putScenario(client, bucket);
    case "get":
      return getScenario(client, bucket);
    case "list":
      return listScenario(client, bucket);
    case "multipart":
      return multipartScenario(client, bucket);
  }
}

function putScenario(client: S3Client, bucket: string): LoadOperation {
  const body = new Uint8Array(64 * 1024);
  crypto.getRandomValues(body);
  let sequence = 0;
  return async () => {
    sequence++;
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: `put/${sequence}.bin`, Body: body }),
    );
  };
}

async function getScenario(client: S3Client, bucket: string): Promise<LoadOperation> {
  const key = "get/seed.bin";
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: new Uint8Array(1024 * 1024) }),
  );
  return async () => {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!response.Body) throw new Error("GET returned no body");
    await response.Body.transformToByteArray();
  };
}

async function listScenario(client: S3Client, bucket: string): Promise<LoadOperation> {
  const body = new Uint8Array([1]);
  for (let i = 0; i < 100; i++) {
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: `list/${String(i).padStart(4, "0")}`, Body: body }),
    );
  }
  return async () => {
    await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "list/", MaxKeys: 100 }));
  };
}

function multipartScenario(client: S3Client, bucket: string): LoadOperation {
  const part = new Uint8Array(256 * 1024);
  crypto.getRandomValues(part);
  let sequence = 0;
  return async () => {
    sequence++;
    const key = `multipart/${sequence}.bin`;
    const upload = await client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
    );
    const completed = [];
    for (let number = 1; number <= 3; number++) {
      const result = await client.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: upload.UploadId,
          PartNumber: number,
          Body: part,
        }),
      );
      completed.push({ PartNumber: number, ETag: result.ETag });
    }
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: upload.UploadId,
        MultipartUpload: { Parts: completed },
      }),
    );
  };
}
