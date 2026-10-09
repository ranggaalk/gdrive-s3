// Backs a bucket up to any S3-compatible service (AWS, R2, B2, Wasabi, MinIO,
// another instance of this gateway). Objects land at
// <prefix>/<bucket name>/<object key>, so restoring is an `aws s3 sync` or an
// `rclone copy` away, and a changed object overwrites its key rather than
// piling up beside it.

import type { AccessibleBucketRow } from "../db/repositories/buckets.ts";
import { applyObjectMetadataHeaders } from "../s3/metadata.ts";
import type { FetchLike } from "../util/fetch-like.ts";
import type { S3DestinationConfig } from "./destination-config.ts";
import { assertPublicEndpoint, PrivateEndpointError, type AddressLookup } from "./endpoint-guard.ts";
import { partSizeFor, S3Client, S3NetworkError, S3RequestError, uploadStream } from "./s3-client.ts";
import {
  bucketKeyPrefix,
  DestinationUnavailableError,
  UnstorableObjectError,
  type BackupPutInput,
  type BackupSink,
  type DestinationProbe,
} from "./sink.ts";

/** S3's limit on a key, in UTF-8 bytes. */
const MAX_KEY_BYTES = 1024;

/** Written by every check, beside the bucket folders. A bucket name cannot
 *  start with ".", so it never collides with one. */
export const MARKER_NAME = ".drives3-backup.json";

export interface S3SinkOptions {
  destinationId: string;
  config: S3DestinationConfig;
  secretAccessKey: string;
  fetch: FetchLike;
  maxAttempts: number;
  partSizeBytes: number;
  allowPrivateEndpoints: boolean;
  gatewayOrigin: string;
  lookup?: AddressLookup;
}

export class S3BackupSink implements BackupSink, DestinationProbe {
  readonly wantsPlaintext = true;
  private readonly client: S3Client;

  constructor(private readonly options: S3SinkOptions) {
    const { config } = options;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      forcePathStyle: config.forcePathStyle,
      accessKeyId: config.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      fetch: options.fetch,
      maxAttempts: options.maxAttempts,
    });
  }

  async prepare(bucket: AccessibleBucketRow): Promise<string> {
    await this.guardEndpoint();
    return bucketKeyPrefix(this.options.config.prefix, bucket.name);
  }

  async put(input: BackupPutInput): Promise<{ destinationId: string }> {
    const key = `${input.ref}${input.object.object_key}`;
    assertStorableKey(key);
    const headers = new Headers();
    applyObjectMetadataHeaders(headers, input.object);
    // Lets a restore tell which version of the object this copy is.
    headers.set("x-amz-meta-drives3-etag", input.object.etag);
    if (this.options.config.storageClass) headers.set("x-amz-storage-class", this.options.config.storageClass);
    await this.guarded(() =>
      uploadStream(this.client, key, input.body, {
        partSize: partSizeFor(input.object.size_bytes, this.options.partSizeBytes),
        headers,
        signal: input.signal,
      }),
    );
    return { destinationId: key };
  }

  /** Proves the credentials can write where copies will go, by writing a
   *  small marker that says what the prefix is for. */
  async check(signal?: AbortSignal): Promise<void> {
    await this.guardEndpoint();
    const { prefix } = this.options.config;
    const marker = JSON.stringify(
      {
        service: "drives3-backup",
        destinationId: this.options.destinationId,
        gateway: this.options.gatewayOrigin,
        layout: "<prefix>/<bucket>/<object key>",
        checkedAt: new Date().toISOString(),
      },
      null,
      2,
    );
    await this.guarded(() =>
      this.client.putObject(
        `${prefix ? `${prefix}/` : ""}${MARKER_NAME}`,
        new TextEncoder().encode(marker),
        new Headers({ "content-type": "application/json" }),
        signal,
      ),
    );
  }

  private async guardEndpoint(): Promise<void> {
    if (this.options.allowPrivateEndpoints) return;
    try {
      await assertPublicEndpoint(this.options.config.endpoint, this.options.lookup);
    } catch (error) {
      if (error instanceof PrivateEndpointError) throw new DestinationUnavailableError(error.message);
      throw error;
    }
  }

  /** Sorts failures into "this destination is unusable" and "this object
   *  did not make it". */
  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof S3RequestError && error.destinationLevel) {
        throw new DestinationUnavailableError(error.message);
      }
      // Retries already ran out; an endpoint that cannot be reached for one
      // object cannot be reached for the next either.
      if (error instanceof S3NetworkError) throw new DestinationUnavailableError(error.message);
      throw error;
    }
  }
}

/**
 * An HTTP client folds "." and ".." path segments away before the request is
 * sent, so such a key would be stored under a different name -- or outside
 * the prefix altogether. Better to say so than to copy it somewhere else.
 */
function assertStorableKey(key: string): void {
  if (Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) {
    throw new UnstorableObjectError(
      `the destination key would be longer than S3's ${MAX_KEY_BYTES}-byte limit`,
    );
  }
  if (key.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new UnstorableObjectError('object keys with "." or ".." path segments cannot be copied to S3');
  }
}
