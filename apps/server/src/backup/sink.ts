// A backup destination as the transfer loop sees it: where one bucket's copies
// go, and how one object gets there. The queue, the per-object ledger and the
// history are shared by every kind of destination; only this part differs.

import type { BackupAccountStatus } from "../db/repositories/backup-accounts.ts";
import type { AccessibleBucketRow } from "../db/repositories/buckets.ts";
import type { ObjectRow } from "../db/repositories/objects.ts";

export interface BackupPutInput {
  /** What prepare() returned for this run: a Drive folder id or a key prefix. */
  ref: string;
  bucket: AccessibleBucketRow;
  object: ObjectRow;
  body: ReadableStream<Uint8Array>;
  signal?: AbortSignal;
}

export interface BackupSink {
  /**
   * Whether the copy should hold the object's readable bytes rather than what
   * the gateway stores. A copy outside Google Drive is only worth having if it
   * restores without this gateway, and an SSE object's stored bytes are
   * ciphertext under a key that lives in this gateway's database.
   */
  readonly wantsPlaintext: boolean;
  /** Resolve the destination for one bucket, once per run. */
  prepare(bucket: AccessibleBucketRow, signal?: AbortSignal): Promise<string>;
  /** Copy one object; destinationId is what the ledger records for it. */
  put(input: BackupPutInput): Promise<{ destinationId: string }>;
}

/** A destination that can be checked before it is saved, and on demand. */
export interface DestinationProbe {
  check(signal?: AbortSignal): Promise<void>;
}

/**
 * The destination itself is unusable: rejected credentials, a bucket or
 * remote that is not there, an endpoint that cannot be reached. Every object
 * left would fail the same way, so the run stops and the destination is
 * flagged, rather than each object burning its retries on a fault it does
 * not have.
 */
export class DestinationUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: Exclude<BackupAccountStatus, "active"> = "error",
  ) {
    super(message);
    this.name = "DestinationUnavailableError";
  }
}

/** An object this destination cannot hold as named. It fails on its own;
 *  the rest of the run carries on. */
export class UnstorableObjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnstorableObjectError";
  }
}

/** Joins a configured prefix and a bucket name into a key prefix: "" or
 *  "a/b/" plus "bucket/". */
export function bucketKeyPrefix(prefix: string, bucketName: string): string {
  return `${prefix ? `${prefix}/` : ""}${bucketName}/`;
}
