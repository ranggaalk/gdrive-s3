// Server-side object copy for the control plane.
//
// The S3 data plane reaches copies through `s3/operations/copy-object.ts`,
// which is driven by request headers. The dashboard needs the same operation
// without an S3 request to parse, so the storage half lives here and both
// callers keep the same two-identity discipline: read with the source owner's
// Drive token, write with the target owner's.

import type { AppContext } from "../context.ts";
import type { AccessibleBucketRow } from "../db/repositories/buckets.ts";
import type { ObjectRow } from "../db/repositories/objects.ts";
import { newVersionId } from "../db/repositories/object-versions.ts";
import { streamingUpload } from "../drive/upload-streaming.ts";
import { EncryptionService } from "./encryption-service.ts";
import { ObjectAccessError, ObjectNotFoundError } from "./object-service.ts";
import { resolveDefaultRetention } from "../s3/object-lock.ts";

export interface CopyResult {
  object: ObjectRow;
  size: number;
}

export class ObjectCopyService {
  constructor(private readonly app: AppContext) {}

  async copy(input: {
    actorUserId: string;
    sourceBucket: AccessibleBucketRow;
    sourceObject: ObjectRow;
    targetBucket: AccessibleBucketRow;
    targetKey: string;
    requestId: string;
    signal?: AbortSignal;
  }): Promise<CopyResult> {
    const { sourceBucket, sourceObject, targetBucket } = input;

    // Each Drive is reached by its own owner's credentials.
    try {
      await this.app.bucketAccess.verifyActorAccess(
        sourceBucket.user_id,
        sourceBucket,
        false,
        input.signal,
      );
      await this.app.bucketAccess.verifyActorAccess(
        targetBucket.user_id,
        targetBucket,
        true,
        input.signal,
      );
    } catch {
      throw new ObjectAccessError();
    }

    const sourceEncryption = this.app.repos.objectEncryption.find(sourceObject.id);
    if (sourceEncryption?.customer_key_md5) {
      // SSE-C keys are never stored, so the gateway cannot read these bytes on
      // the caller's behalf; the copy has to go through the S3 API with the
      // key supplied.
      throw new ObjectAccessError();
    }

    // The target follows its own bucket's encryption and lock rules.
    const encryption = new EncryptionService(this.app).planFor({
      ownerUserId: targetBucket.user_id,
      bucket: targetBucket,
      request: { kind: "none" },
    });
    const defaultRetention = resolveDefaultRetention(targetBucket.object_lock_default_json);
    const lock = targetBucket.object_lock_enabled
      ? {
          mode: defaultRetention?.mode ?? null,
          retainUntil: defaultRetention?.retainUntil ?? null,
          legalHold: false,
        }
      : null;

    const versionId = targetBucket.versioning === "Enabled" ? newVersionId() : "null";
    const previous = this.app.repos.objects.findByKey(targetBucket.id, input.targetKey);
    const staging = this.app.repos.objectStaging.start({
      requestId: `${input.requestId}:copy:${crypto.randomUUID()}`,
      userId: targetBucket.user_id,
      bucketId: targetBucket.id,
      objectKey: input.targetKey,
      contentType: sourceObject.content_type,
      metadata: parseMetadata(sourceObject.metadata_json),
      cacheControl: sourceObject.cache_control,
      contentDisposition: sourceObject.content_disposition,
      contentEncoding: sourceObject.content_encoding,
      contentLanguage: sourceObject.content_language,
      expiresAt: sourceObject.expires_at,
      acl: sourceObject.acl,
      lock,
      sse: encryption
        ? {
            algorithm: encryption.algorithm,
            kmsKeyId: encryption.kmsKeyId,
            kmsKeyVersion: encryption.kmsKeyVersion,
            wrappedDataKey: encryption.wrappedDataKey,
            iv: encryption.iv.toString("base64"),
            customerKeyMd5: encryption.customerKeyMd5,
          }
        : null,
      oldDriveFileId: previous?.drive_file_id ?? null,
      driveTargetId: targetBucket.drive_target_id,
    });

    let uploadedId: string | null = null;
    const slot = await this.app.driveLimits.upload(targetBucket.user_id, input.signal);
    try {
      const upstream = await this.app.driveStorage.downloadObject({
        userId: sourceBucket.user_id,
        driveFileId: sourceObject.drive_file_id,
        target: this.app.bucketAccess.operationTarget(sourceBucket),
        signal: input.signal,
      });
      if (!upstream.ok || !upstream.body) throw new ObjectNotFoundError();

      let body = upstream.body;
      if (sourceEncryption) {
        body = new EncryptionService(this.app).decryptorFor({
          encryption: sourceEncryption,
          customerKey: null,
          byteOffset: 0,
        })(body);
      }

      const result = await streamingUpload({
        storage: this.app.driveStorage,
        userId: targetBucket.user_id,
        bucketId: targetBucket.id,
        bucketFolderId: targetBucket.drive_folder_id,
        objectId: staging.object_id,
        objectKey: input.targetKey,
        mimeType: sourceObject.content_type,
        body,
        contentLength: sourceObject.size_bytes,
        maxBytes: this.app.config.maxSinglePutBytes,
        resumableThreshold: this.app.config.driveResumableThresholdBytes,
        chunkSize: this.app.config.driveUploadChunkBytes,
        target: this.app.bucketAccess.operationTarget(targetBucket),
        signal: input.signal,
        ...(encryption
          ? { cipher: new EncryptionService(this.app).cipherFor(encryption) }
          : {}),
      });
      uploadedId = result.uploaded.driveFileId;
      this.app.repos.objectStaging.markUploaded({
        id: staging.id,
        driveFileId: uploadedId,
        sizeBytes: result.size,
        etag: result.md5Hex,
        checksumSha256: result.sha256Hex,
      });
      const committed = this.app.repos.objects.commitStagedObject(staging.id, {
        versioning: targetBucket.versioning,
        versionId,
      });
      return { object: committed.current, size: result.size };
    } catch (error) {
      this.app.repos.objectStaging.markFailed(
        staging.id,
        error instanceof Error ? error.message : "copy failed",
      );
      if (uploadedId) {
        this.app.repos.pendingCleanup.enqueue({
          userId: targetBucket.user_id,
          resourceType: "drive_file",
          resourceId: uploadedId,
          reason: "failed_object_copy",
          driveTargetId: targetBucket.drive_target_id,
        });
      }
      throw error;
    } finally {
      slot.release();
    }
  }
}

function parseMetadata(raw: string): Record<string, string> {
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}
