// Streaming upload orchestrator (AGENTS.md §8, §17). Decides between Drive
// multipart and resumable upload, chunks the body, streams MD5/SHA-256, and
// enforces the per-request size limit. Never buffers a full object in RAM.

import { createHash } from "node:crypto";
import type {
  DriveOperationTarget,
  DriveStorage,
  UploadedObject,
} from "./storage.ts";
import { S3Error } from "../s3/errors.ts";

export interface StreamingUploadInput {
  storage: DriveStorage;
  userId: string;
  bucketId: string;
  bucketFolderId: string;
  objectId: string;
  mimeType: string;
  body: ReadableStream<Uint8Array>;
  contentLength: number | null;
  maxBytes: number;
  resumableThreshold: number;
  chunkSize: number;
  target?: DriveOperationTarget;
  signal?: AbortSignal;
}

export interface StreamingUploadResult {
  uploaded: UploadedObject;
  size: number;
  md5Hex: string;
  sha256Hex: string;
}

const RESUMABLE_ALIGNMENT = 256 * 1024;

export async function streamingUpload(input: StreamingUploadInput): Promise<StreamingUploadResult> {
  if (input.contentLength !== null && input.contentLength > input.maxBytes) {
    throw new S3Error("EntityTooLarge");
  }

  const useResumable =
    input.contentLength === null ||
    input.contentLength > input.resumableThreshold ||
    input.contentLength > input.chunkSize;

  if (useResumable) return uploadResumable(input);
  return uploadMultipart(input);
}

async function uploadMultipart(input: StreamingUploadInput): Promise<StreamingUploadResult> {
  const md5 = createHash("md5");
  const sha256 = createHash("sha256");
  const reader = input.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    input.signal?.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > input.maxBytes) throw new S3Error("EntityTooLarge");
    md5.update(value);
    sha256.update(value);
    chunks.push(value);
  }

  const body = concatUint8(chunks, size);
  const uploaded = await input.storage.uploadObject({
    userId: input.userId,
    bucketFolderId: input.bucketFolderId,
    objectId: input.objectId,
    bucketId: input.bucketId,
    mimeType: input.mimeType,
    body,
    target: input.target,
    signal: input.signal,
  });
  return { uploaded, size, md5Hex: md5.digest("hex"), sha256Hex: sha256.digest("hex") };
}

async function uploadResumable(input: StreamingUploadInput): Promise<StreamingUploadResult> {
  const chunkTarget = alignChunk(input.chunkSize);
  const session = await input.storage.beginResumableUpload({
    userId: input.userId,
    bucketFolderId: input.bucketFolderId,
    objectId: input.objectId,
    bucketId: input.bucketId,
    mimeType: input.mimeType,
    target: input.target,
    signal: input.signal,
  });

  const md5 = createHash("md5");
  const sha256 = createHash("sha256");
  const reader = input.body.getReader();
  let buffer = new Uint8Array(0);
  let uploadedSize = 0;
  let streamedSize = 0;
  let uploaded: UploadedObject | null = null;
  let done = false;

  while (!done) {
    input.signal?.throwIfAborted();
    const next = await reader.read();
    if (next.value && next.value.byteLength > 0) {
      streamedSize += next.value.byteLength;
      if (streamedSize > input.maxBytes) throw new S3Error("EntityTooLarge");
      md5.update(next.value);
      sha256.update(next.value);
      buffer = append(buffer, next.value);
    }
    done = next.done;
    // Keep the last full chunk buffered until EOF so an exact chunk-multiple
    // object can send that chunk with a concrete final total (not `*/total`).
    while (buffer.byteLength > chunkTarget || (done && buffer.byteLength > 0)) {
      const take = done ? buffer.byteLength : chunkTarget;
      const chunk = buffer.subarray(0, take);
      buffer = buffer.subarray(take);
      const isFinal = done && buffer.byteLength === 0;
      const total = isFinal
        ? uploadedSize + chunk.byteLength
        : input.contentLength ?? null;
      if (input.contentLength !== null && uploadedSize + chunk.byteLength > input.maxBytes) {
        throw new S3Error("EntityTooLarge");
      }
      const progress = await input.storage.uploadResumableChunk({
        userId: input.userId,
        sessionUrl: session.sessionUrl,
        chunk,
        startOffset: uploadedSize,
        totalBytes: total,
        isFinal,
        target: input.target,
        signal: input.signal,
      });
      uploadedSize = progress.committedBytes;
      if (progress.uploaded) uploaded = progress.uploaded;
      if (!isFinal && buffer.byteLength < chunkTarget) break;
    }
  }

  if (!uploaded) {
    // Empty body or exact chunk multiple: finalize with a zero-length marker
    // at the current committed offset.
    const progress = await input.storage.uploadResumableChunk({
      userId: input.userId,
      sessionUrl: session.sessionUrl,
      chunk: new Uint8Array(),
      startOffset: uploadedSize,
      totalBytes: uploadedSize,
      isFinal: true,
      target: input.target,
      signal: input.signal,
    });
    if (!progress.uploaded) throw new S3Error("InternalError");
    uploaded = progress.uploaded;
    uploadedSize = progress.committedBytes;
  }

  return {
    uploaded,
    size: uploadedSize,
    md5Hex: md5.digest("hex"),
    sha256Hex: sha256.digest("hex"),
  };
}

function append(existing: Uint8Array, next: Uint8Array): Uint8Array {
  if (existing.byteLength === 0) return next.slice();
  const out = new Uint8Array(existing.byteLength + next.byteLength);
  out.set(existing, 0);
  out.set(next, existing.byteLength);
  return out;
}

function concatUint8(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function alignChunk(chunkSize: number): number {
  if (chunkSize < RESUMABLE_ALIGNMENT) return RESUMABLE_ALIGNMENT;
  return Math.floor(chunkSize / RESUMABLE_ALIGNMENT) * RESUMABLE_ALIGNMENT;
}
