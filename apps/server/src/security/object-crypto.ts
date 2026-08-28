// Object body encryption for server-side encryption.
//
// AES-256-CTR, not GCM. GCM would authenticate the ciphertext, but it can only
// be verified by reading the whole object, which would break range GETs — the
// one thing this gateway must keep cheap. CTR is seekable: the counter for any
// byte offset can be computed directly, so `GET Range: bytes=5000000-5000100`
// still fetches only the bytes it needs.
//
// Integrity is not lost by that choice: every object already carries a
// streaming SHA-256 (`objects.checksum_sha256`) computed over the plaintext at
// upload time, and Drive stores its own MD5. What CTR gives up versus GCM is
// detection of a *targeted* ciphertext edit by whoever controls the Drive file,
// which is the same trust boundary the unencrypted path already has.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-ctr";
export const IV_BYTES = 16;
export const DATA_KEY_BYTES = 32;
const AES_BLOCK_BYTES = 16;

export function generateIv(): Buffer {
  return randomBytes(IV_BYTES);
}

export function generateDataKey(): Buffer {
  return randomBytes(DATA_KEY_BYTES);
}

/**
 * The CTR counter block for a given byte offset.
 *
 * AES-CTR treats the 16-byte IV as a big-endian counter incremented once per
 * 16-byte block, so seeking to byte N means adding floor(N / 16) to it. The
 * addition wraps within the 128-bit block, exactly as the cipher does.
 */
export function counterBlockAt(iv: Buffer, byteOffset: number): Buffer {
  if (byteOffset < 0 || !Number.isSafeInteger(byteOffset)) {
    throw new RangeError("byteOffset must be a non-negative safe integer");
  }
  const block = Buffer.from(iv);
  let increment = BigInt(Math.floor(byteOffset / AES_BLOCK_BYTES));
  for (let index = block.length - 1; index >= 0 && increment > 0n; index--) {
    const sum = BigInt(block[index]!) + (increment & 0xffn);
    block[index] = Number(sum & 0xffn);
    increment = (increment >> 8n) + (sum >> 8n);
  }
  return block;
}

/**
 * Encrypt a stream from the beginning. CTR is length-preserving, so the
 * object's stored size stays the plaintext size and Content-Length needs no
 * adjustment.
 */
export function encryptStream(
  key: Buffer,
  iv: Buffer,
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const cipher = createCipheriv(ALGORITHM, key, iv);
  return transformThrough(source, (chunk) => cipher.update(chunk), () => cipher.final());
}

/**
 * Decrypt a stream that starts at `byteOffset` into the plaintext.
 *
 * The counter is seeked to the offset's block, and any bytes before the offset
 * within that block are produced and discarded — without that, a range whose
 * start is not a multiple of 16 would decrypt to garbage.
 */
export function decryptStream(
  key: Buffer,
  iv: Buffer,
  source: ReadableStream<Uint8Array>,
  byteOffset = 0,
): ReadableStream<Uint8Array> {
  const decipher = createDecipheriv(ALGORITHM, key, counterBlockAt(iv, byteOffset));
  const partialBlockBytes = byteOffset % AES_BLOCK_BYTES;
  if (partialBlockBytes > 0) {
    // Burn the keystream for the bytes before the range start within its
    // block; without this a range that does not begin on a 16-byte boundary
    // decrypts to garbage.
    decipher.update(Buffer.alloc(partialBlockBytes));
  }
  return transformThrough(source, (chunk) => decipher.update(chunk), () => decipher.final());
}

function transformThrough(
  source: ReadableStream<Uint8Array>,
  update: (chunk: Buffer) => Buffer,
  final: () => Buffer,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          const tail = final();
          if (tail.length > 0) controller.enqueue(new Uint8Array(tail));
          controller.close();
          return;
        }
        if (value && value.byteLength > 0) {
          const out = update(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
          if (out.length > 0) controller.enqueue(new Uint8Array(out));
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    },
  });
}
