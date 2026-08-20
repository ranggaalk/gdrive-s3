// Multipart temp-file streaming helpers. Part bytes are never concatenated in
// RAM; each file is opened and read sequentially in bounded chunks.

import { open, stat, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { MultipartPartRow } from "../db/repositories/multipart-parts.ts";

const READ_CHUNK_BYTES = 256 * 1024;

export function multipartConcatStream(parts: MultipartPartRow[]): ReadableStream<Uint8Array> {
  let index = 0;
  let current: FileHandle | null = null;
  let position = 0;

  async function closeCurrent(): Promise<void> {
    if (!current) return;
    await current.close().catch(() => {});
    current = null;
    position = 0;
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (!current) {
          if (index >= parts.length) {
            controller.close();
            return;
          }
          current = await open(parts[index++]!.temp_path, "r");
          position = 0;
        }
        const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        const handle = current;
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) {
          await closeCurrent();
          continue;
        }
        position += bytesRead;
        controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead));
        return;
      }
    },
    async cancel() {
      await closeCurrent();
    },
  });
}

export async function validatePartFiles(parts: MultipartPartRow[]): Promise<void> {
  for (const part of parts) {
    const s = await stat(part.temp_path);
    if (!s.isFile() || s.size !== part.size_bytes) {
      throw new Error(`multipart part ${part.part_number} file mismatch`);
    }
  }
}

export function multipartEtag(parts: MultipartPartRow[]): string {
  const combined = Buffer.concat(parts.map((part) => Buffer.from(part.etag, "hex")));
  return `${createHash("md5").update(combined).digest("hex")}-${parts.length}`;
}
