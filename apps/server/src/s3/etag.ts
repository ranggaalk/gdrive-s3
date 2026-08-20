// ETag helpers (AGENTS.md §13). Single-part ETag = hex MD5 of the exact body.

import { createHash } from "node:crypto";

export function md5Hex(data: Uint8Array | string): string {
  return createHash("md5").update(data).digest("hex");
}

export function quoteEtag(hex: string): string {
  return `"${hex.replace(/^"|"$/g, "")}"`;
}

/** Hash a stream while forwarding its chunks unchanged. */
export function md5Passthrough(
  source: ReadableStream<Uint8Array>,
): {
  stream: ReadableStream<Uint8Array>;
  digest: Promise<{ hex: string; sha256Hex: string; size: number }>;
} {
  const hash = createHash("md5");
  const sha256 = createHash("sha256");
  let size = 0;
  let resolve!: (result: { hex: string; sha256Hex: string; size: number }) => void;
  let reject!: (err: unknown) => void;
  const digest = new Promise<{ hex: string; sha256Hex: string; size: number }>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const reader = source.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          resolve({ hex: hash.digest("hex"), sha256Hex: sha256.digest("hex"), size });
          controller.close();
          return;
        }
        if (value) {
          hash.update(value);
          sha256.update(value);
          size += value.byteLength;
          controller.enqueue(value);
        }
      } catch (err) {
        reject(err);
        controller.error(err);
      }
    },
    cancel(reason) {
      reject(reason);
      return reader.cancel(reason);
    },
  });
  return { stream, digest };
}
