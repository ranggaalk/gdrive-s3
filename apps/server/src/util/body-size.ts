// Bounded body readers (AGENTS.md §20). Neither JSON nor XML control-plane
// payloads should force us to buffer arbitrary attacker-chosen sizes into
// memory. The helpers stream and throw as soon as the byte counter crosses
// the configured limit.

export class BodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`request body exceeded ${limitBytes} bytes`);
  }
}

/**
 * Read a Web ReadableStream (or null) as UTF-8 text, refusing to grow past
 * `maxBytes`. Returns the empty string when the body is null. Consumes the
 * stream fully; the caller is responsible for the lifecycle.
 */
export async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!body) return "";
  if (maxBytes <= 0) throw new BodyTooLargeError(maxBytes);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new BodyTooLargeError(maxBytes);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8").decode(mergeChunks(chunks, total));
}

/**
 * Parse a request as JSON, bounded by `maxBytes`. Returns null on any parse
 * failure or missing body; throws `BodyTooLargeError` when the byte cap is
 * exceeded so callers can surface a 413 without swallowing the signal.
 */
export async function readBoundedJson<T>(
  req: Request,
  maxBytes: number,
): Promise<T | null> {
  const text = await readBoundedText(req.body, maxBytes);
  if (text === "") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function mergeChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
