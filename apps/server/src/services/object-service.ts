import type { AccessibleBucketRow } from "../db/repositories/buckets.ts";
import {
  ObjectKeyConflictError,
  type ObjectRow,
} from "../db/repositories/objects.ts";
import type { DriveOperationTarget } from "../drive/storage.ts";
import { streamingUpload, type StreamingUploadResult } from "../drive/upload-streaming.ts";
import type { ObjectMetadataHeaders } from "../s3/metadata.ts";
import { parseRange } from "../s3/range.ts";
import type { AppContext } from "../context.ts";
import { EncryptionService, type EncryptionPlan } from "./encryption-service.ts";
import { newVersionId } from "../db/repositories/object-versions.ts";
import type { ObjectEncryptionRow } from "../db/repositories/object-encryption.ts";

export class ObjectAccessError extends Error {}
export class ObjectNotFoundError extends Error {}
export class ObjectAlreadyExistsError extends Error {}

export interface ObjectUploadInput {
  actorUserId: string;
  bucket: AccessibleBucketRow;
  key: string;
  requestId: string;
  body: ReadableStream<Uint8Array>;
  contentLength: number | null;
  metadata: ObjectMetadataHeaders;
  /** Canned ACL for the object, carried through staging so it commits in the
   *  same transaction that publishes the object. */
  acl?: string;
  /** Server-side encryption to apply, or null/undefined for plaintext. */
  encryption?: EncryptionPlan | null;
  /** Bucket versioning mode at the time of the write. */
  versioning?: "Disabled" | "Enabled" | "Suspended";
  /** Version id for the new object. */
  versionId?: string;
  /** Object Lock state to publish alongside the object. */
  lock?: { mode: string | null; retainUntil: string | null; legalHold: boolean } | null;
  signal?: AbortSignal;
  verify?: (result: StreamingUploadResult) => void;
  ifAbsent?: boolean;
  /** Caps the upload below the server-wide limit. A POST policy's
   *  content-length-range uses this so an oversize body fails while streaming
   *  instead of after the whole object has landed in Drive. */
  maxBytes?: number;
}

export interface ObjectDownloadInput {
  actorUserId: string;
  bucket: AccessibleBucketRow;
  object: ObjectRow;
  range: string | null;
  signal?: AbortSignal;
  /** SSE-C key supplied by the caller, required for objects written with one. */
  customerKey?: { key: Buffer; keyMd5: string } | null;
  /** Set when reading an archived version, which by definition has no row in
   *  `objects` to check freshness against. */
  skipCurrentCheck?: boolean;
  /** Encryption metadata for an archived version, which is stored on the
   *  version row rather than in object_encryption. */
  encryptionOverride?: ObjectEncryptionRow | null;
}

export interface ObjectDownloadResult {
  body: ReadableStream<Uint8Array> | null;
  status: number;
  contentLength: number;
  contentRange: string | null;
}

export class ObjectService {
  constructor(private readonly app: AppContext) {}

  async upload(input: ObjectUploadInput): Promise<{
    current: ObjectRow;
    previous: ObjectRow | null;
    result: StreamingUploadResult;
  }> {
    const keyLock = await this.app.uploadLocks.acquire(
      `object:${input.bucket.id}:${input.key}`,
      input.signal,
    );
    try {
      await this.verifyAccess(input.actorUserId, input.bucket, true, input.signal);
      const previous = input.ifAbsent
        ? this.app.repos.objects.findAnyByKey(input.bucket.id, input.key)
        : this.app.repos.objects.findByKey(input.bucket.id, input.key);
      if (input.ifAbsent && previous) throw new ObjectAlreadyExistsError();
      const target = this.app.bucketAccess.operationTarget(input.bucket);
      const staging = this.app.repos.objectStaging.start({
        requestId: input.requestId,
        userId: input.bucket.user_id,
        bucketId: input.bucket.id,
        driveTargetId: input.bucket.drive_target_id,
        objectKey: input.key,
        contentType: input.metadata.contentType,
        metadata: input.metadata.userMetadata,
        cacheControl: input.metadata.cacheControl,
        contentDisposition: input.metadata.contentDisposition,
        contentEncoding: input.metadata.contentEncoding,
        contentLanguage: input.metadata.contentLanguage,
        expiresAt: input.metadata.expiresAt,
        acl: input.acl,
        lock: input.lock,
        sse: input.encryption
          ? {
              algorithm: input.encryption.algorithm,
              kmsKeyId: input.encryption.kmsKeyId,
              kmsKeyVersion: input.encryption.kmsKeyVersion,
              wrappedDataKey: input.encryption.wrappedDataKey,
              iv: input.encryption.iv.toString("base64"),
              customerKeyMd5: input.encryption.customerKeyMd5,
            }
          : null,
        oldDriveFileId: previous?.drive_file_id ?? null,
      });

      const slot = await this.app.driveLimits.upload(input.actorUserId, input.signal);
      let uploadedDriveFileId: string | null = null;
      try {
        const result = await streamingUpload({
          storage: this.app.driveStorage,
          userId: input.actorUserId,
          bucketId: input.bucket.id,
          bucketFolderId: input.bucket.drive_folder_id,
          objectId: staging.object_id,
          objectKey: input.key,
          mimeType: input.metadata.contentType,
          body: input.body,
          contentLength: input.contentLength,
          maxBytes: Math.min(
            input.maxBytes ?? Number.POSITIVE_INFINITY,
            this.app.config.maxSinglePutBytes,
          ),
          resumableThreshold: this.app.config.driveResumableThresholdBytes,
          chunkSize: this.app.config.driveUploadChunkBytes,
          target,
          signal: input.signal,
          ...(input.encryption
            ? { cipher: new EncryptionService(this.app).cipherFor(input.encryption) }
            : {}),
        });
        uploadedDriveFileId = result.uploaded.driveFileId;
        input.verify?.(result);
        this.app.repos.objectStaging.markUploaded({
          id: staging.id,
          driveFileId: result.uploaded.driveFileId,
          sizeBytes: result.size,
          etag: result.md5Hex,
          checksumSha256: result.sha256Hex,
        });
        const committed = this.app.repos.objects.commitStagedObject(staging.id, {
          ifAbsent: input.ifAbsent,
          versioning: input.versioning,
          versionId: input.versionId,
        });
        uploadedDriveFileId = null;
        // The repository decides whether the previous row was retained; if it
        // was, its Drive file still backs that version and must survive.
        if (
          !committed.archivedPrevious &&
          committed.previous &&
          committed.previous.drive_file_id !== result.uploaded.driveFileId
        ) {
          await this.drainDriveFileNow(
            input.actorUserId,
            input.bucket.user_id,
            committed.previous.drive_file_id,
            target,
            input.signal,
          );
        }
        return { ...committed, result };
      } catch (error) {
        const failed = this.app.repos.objectStaging.byId(staging.id);
        const committed = failed?.status === "committed";
        if (!committed) {
          this.app.repos.objectStaging.markFailed(
            staging.id,
            error instanceof Error ? error.message : "upload failed",
          );
        }
        if (uploadedDriveFileId && !committed) {
          this.app.repos.pendingCleanup.enqueue({
            userId: input.bucket.user_id,
            resourceType: "drive_file",
            resourceId: uploadedDriveFileId,
            reason: "failed_object_staging",
            driveTargetId: input.bucket.drive_target_id,
          });
        }
        if (error instanceof ObjectKeyConflictError) {
          throw new ObjectAlreadyExistsError();
        }
        throw error;
      } finally {
        slot.release();
      }
    } finally {
      keyLock.release();
    }
  }

  async download(input: ObjectDownloadInput): Promise<ObjectDownloadResult> {
    await this.verifyAccess(input.actorUserId, input.bucket, false, input.signal);
    let object = input.object;
    if (!input.skipCurrentCheck) {
      const current = this.app.repos.objects.findActiveByIdInBucket(
        input.bucket.id,
        input.object.id,
      );
      if (!current || current.drive_file_id !== input.object.drive_file_id) {
        throw new ObjectNotFoundError();
      }
      object = current;
    }
    const parsedRange = parseRange(input.range, object.size_bytes);
    const slot = await this.app.driveLimits.download(input.actorUserId, input.signal);
    let upstream: Response;
    try {
      upstream = await this.app.driveStorage.downloadObject({
        userId: input.actorUserId,
        driveFileId: object.drive_file_id,
        range: parsedRange?.headerValue,
        target: this.app.bucketAccess.operationTarget(input.bucket),
        signal: input.signal,
      });
    } catch (error) {
      slot.release();
      throw error;
    }
    if (upstream.status === 404) {
      slot.release();
      this.app.repos.objects.markStatus(input.bucket.user_id, object.id, "missing");
      throw new ObjectNotFoundError();
    }
    if (upstream.status < 200 || upstream.status >= 300) {
      await upstream.body?.cancel().catch(() => {});
      slot.release();
      throw new Error(`Drive download failed with status ${upstream.status}`);
    }
    const contentLength = parsedRange
      ? parsedRange.length
      : Number(upstream.headers.get("content-length") ?? object.size_bytes);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      await upstream.body?.cancel().catch(() => {});
      slot.release();
      throw new Error("Drive returned an invalid content length");
    }
    // Decrypt on the way out. CTR is seekable, so a ranged read only needs the
    // counter advanced to the range start — the object is never fetched whole
    // just to serve a slice of it.
    const encryption =
      input.encryptionOverride !== undefined
        ? input.encryptionOverride
        : this.app.repos.objectEncryption.find(object.id);
    let body = wrapBody(upstream, slot);
    if (encryption && body) {
      const decrypt = new EncryptionService(this.app).decryptorFor({
        encryption,
        customerKey: input.customerKey ?? null,
        byteOffset: parsedRange?.start ?? 0,
      });
      body = decrypt(body);
    }

    return {
      body,
      status: parsedRange ? 206 : upstream.status,
      contentLength,
      contentRange: parsedRange
        ? `bytes ${parsedRange.start}-${parsedRange.end}/${parsedRange.totalSize}`
        : null,
    };
  }

  /**
   * Delete an object.
   *
   * With versioning enabled this is not a deletion at all: the current row is
   * archived and a delete marker takes its place, so the bytes survive and the
   * key simply stops resolving. `deleteMarkerVersionId` is returned so the
   * caller can report `x-amz-version-id` and `x-amz-delete-marker`.
   */
  async delete(input: {
    actorUserId: string;
    bucket: AccessibleBucketRow;
    object: ObjectRow;
    reason: string;
    signal?: AbortSignal;
  }): Promise<{ removed: ObjectRow | null; deleteMarkerVersionId: string | null }> {
    await this.verifyAccess(input.actorUserId, input.bucket, true, input.signal);
    const current = this.app.repos.objects.findActiveByIdInBucket(
      input.bucket.id,
      input.object.id,
    );
    if (!current || current.drive_file_id !== input.object.drive_file_id) {
      throw new ObjectNotFoundError();
    }

    const versioning = input.bucket.versioning;
    if (versioning === "Enabled" || versioning === "Suspended") {
      // Suspended still inserts a marker — the key must stop resolving — but
      // it uses the 'null' version id and replaces any existing null version,
      // exactly as a suspended write does.
      const markerVersionId = versioning === "Enabled" ? newVersionId() : "null";
      const retainCurrent = versioning === "Enabled" || current.version_id !== "null";

      if (retainCurrent) {
        const encryption = this.app.repos.objectEncryption.find(current.id);
        this.app.repos.objectVersions.archive({ object: current, encryption });
      }
      this.app.repos.objectVersions.clearLatest(input.bucket.id, current.object_key);
      // A null marker would collide with an earlier null version row, so clear
      // it first; under suspension that row is the one being replaced anyway.
      if (markerVersionId === "null") {
        this.app.repos.objectVersions.delete(input.bucket.id, current.object_key, "null");
      }
      this.app.repos.objectVersions.insertDeleteMarker({
        bucketId: input.bucket.id,
        objectKey: current.object_key,
        versionId: markerVersionId,
      });

      // Drop only the namespace row. When the version was retained its Drive
      // file backs that version; when it was not, the bytes are unreachable
      // and must be released.
      this.app.repos.objects.deleteByKey(input.bucket.id, current.object_key);
      if (!retainCurrent) {
        this.app.repos.pendingCleanup.enqueue({
          userId: input.bucket.user_id,
          resourceType: "drive_file",
          resourceId: current.drive_file_id,
          reason: input.reason,
          driveTargetId: input.bucket.drive_target_id,
        });
        await this.drainDriveFileNow(
          input.actorUserId,
          input.bucket.user_id,
          current.drive_file_id,
          this.app.bucketAccess.operationTarget(input.bucket),
          input.signal,
        );
      }
      return { removed: current, deleteMarkerVersionId: markerVersionId };
    }

    const removed = this.app.repos.objects.deleteAndQueueCleanup({
      userId: input.bucket.user_id,
      bucketId: input.bucket.id,
      objectKey: current.object_key,
      reason: input.reason,
      driveTargetId: input.bucket.drive_target_id,
    });
    if (removed) {
      await this.drainDriveFileNow(
        input.actorUserId,
        input.bucket.user_id,
        removed.drive_file_id,
        this.app.bucketAccess.operationTarget(input.bucket),
        input.signal,
      );
    }
    return { removed, deleteMarkerVersionId: null };
  }

  private async verifyAccess(
    actorUserId: string,
    bucket: AccessibleBucketRow,
    requireWrite: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.app.bucketAccess.verifyActorAccess(actorUserId, bucket, requireWrite, signal);
    } catch {
      throw new ObjectAccessError();
    }
  }

  private async drainDriveFileNow(
    actorUserId: string,
    cleanupUserId: string,
    driveFileId: string,
    target: DriveOperationTarget,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.app.driveStorage.deleteFile({
        userId: actorUserId,
        driveFileId,
        mode: this.app.config.s3DeleteMode,
        target,
        signal,
      });
    } catch {
      return;
    }
    this.app.repos.pendingCleanup.completeResource(cleanupUserId, "drive_file", driveFileId);
  }
}

function wrapBody(
  upstream: Response,
  slot: { release(): void },
): ReadableStream<Uint8Array> | null {
  if (!upstream.body) {
    slot.release();
    return null;
  }
  const reader = upstream.body.getReader();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    slot.release();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else if (value) {
          controller.enqueue(value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason);
    },
  });
}
