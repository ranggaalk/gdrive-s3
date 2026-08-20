// Safe multipart temp-file paths (AGENTS.md §14). Never use a user-provided
// filesystem path. uploadId and partNumber are validated before joining.

import { mkdir, open, rename, lstat, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const UPLOAD_ID = /^mpu_[a-f0-9]{32}$/;

export function assertUploadId(uploadId: string): void {
  if (!UPLOAD_ID.test(uploadId)) throw new Error("invalid multipart upload id");
}

export function assertPartNumber(partNumber: number, maxParts = 10_000): void {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > maxParts) {
    throw new Error("invalid multipart part number");
  }
}

export function assertUnder(baseDir: string, targetPath: string): string {
  const base = resolve(baseDir);
  const target = resolve(targetPath);
  const rel = relative(base, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("multipart temp path escapes configured directory");
  }
  return target;
}

export function multipartUploadDir(baseDir: string, uploadId: string): string {
  assertUploadId(uploadId);
  return assertUnder(baseDir, resolve(baseDir, uploadId));
}

export function multipartPartPath(
  baseDir: string,
  uploadId: string,
  partNumber: number,
  maxParts = 10_000,
): string {
  assertUploadId(uploadId);
  assertPartNumber(partNumber, maxParts);
  return assertUnder(baseDir, resolve(baseDir, uploadId, `${partNumber}.part`));
}

/** Ensure upload directory exists and contains no symlink components. */
export async function ensureSafeUploadDir(baseDir: string, uploadId: string): Promise<string> {
  const base = resolve(baseDir);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const baseStat = await lstat(base);
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
    throw new Error("multipart base directory is not a real directory");
  }

  const dir = multipartUploadDir(base, uploadId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("multipart upload directory is not a real directory");
  }
  return dir;
}

/**
 * Stream a part to a private `.tmp` file, then atomically rename it into place.
 * Caller writes chunks through the returned file handle.
 */
export async function openAtomicPart(
  baseDir: string,
  uploadId: string,
  partNumber: number,
  maxParts = 10_000,
) {
  await ensureSafeUploadDir(baseDir, uploadId);
  const finalPath = multipartPartPath(baseDir, uploadId, partNumber, maxParts);
  const tempPath = assertUnder(baseDir, `${finalPath}.${crypto.randomUUID()}.tmp`);
  await mkdir(dirname(tempPath), { recursive: true, mode: 0o700 });
  const handle = await open(tempPath, "wx", 0o600);
  return {
    finalPath,
    tempPath,
    handle,
    async commit(): Promise<void> {
      await handle.sync();
      await handle.close();
      await rename(tempPath, finalPath);
    },
    async abort(): Promise<void> {
      await handle.close().catch(() => {});
      await rm(tempPath, { force: true }).catch(() => {});
    },
  };
}
