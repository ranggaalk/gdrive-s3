// Streaming multipart/form-data reader for PresignedPost uploads.
//
// The platform `Request.formData()` would be far less code, but it buffers
// every part in memory — including the file — which is exactly what this
// gateway must never do. So the body is walked by hand: the small leading
// fields are collected under a hard byte cap, and the `file` part is handed
// back as a stream that stops at the closing boundary.
//
// S3 requires `file` to be the final field for the same reason: the policy
// fields have to be known before a single byte of content is accepted.

import { S3Error } from "./errors.ts";

export interface MultipartFile {
  filename: string | null;
  contentType: string | null;
  stream: ReadableStream<Uint8Array>;
}

export interface MultipartFormResult {
  /** Field values keyed by lowercased field name. */
  fields: Map<string, string>;
  /** Null when the form carried no `file` part. */
  file: MultipartFile | null;
}

const DASH_DASH = new TextEncoder().encode("--");
const CRLF = new TextEncoder().encode("\r\n");
const CRLF_CRLF = new TextEncoder().encode("\r\n\r\n");

/** Pull the boundary out of the Content-Type header. */
export function parseBoundary(contentType: string | null): string | null {
  if (!contentType) return null;
  const [type, ...rest] = contentType.split(";");
  if (!type || type.trim().toLowerCase() !== "multipart/form-data") return null;
  for (const part of rest) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim().toLowerCase();
    if (name !== "boundary") continue;
    let value = part.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return from;
  const last = haystack.length - needle.length;
  outer: for (let i = from; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * A cursor over the request body that can look ahead for delimiters without
 * pulling the whole stream into memory.
 */
class BodyCursor {
  private pending = new Uint8Array(0);
  private exhausted = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  get buffered(): Uint8Array {
    return this.pending;
  }

  get atEnd(): boolean {
    return this.exhausted && this.pending.length === 0;
  }

  /** Read one more chunk. Returns false once the body is finished. */
  async pull(): Promise<boolean> {
    if (this.exhausted) return false;
    const { done, value } = await this.reader.read();
    if (done) {
      this.exhausted = true;
      return false;
    }
    if (value && value.length > 0) this.pending = concat(this.pending, value);
    return true;
  }

  /** Grow the buffer until `needle` appears or the body ends. */
  async findWithin(needle: Uint8Array, limit: number): Promise<number> {
    for (;;) {
      const found = indexOf(this.pending, needle);
      if (found !== -1) return found;
      if (this.pending.length > limit) return -1;
      if (!(await this.pull())) return indexOf(this.pending, needle);
    }
  }

  consume(count: number): Uint8Array {
    const taken = this.pending.subarray(0, count);
    this.pending = this.pending.subarray(count);
    return taken;
  }

  async ensure(count: number): Promise<boolean> {
    while (this.pending.length < count) {
      if (!(await this.pull())) return false;
    }
    return true;
  }

  cancel(reason?: unknown): Promise<void> {
    return this.reader.cancel(reason).catch(() => {});
  }
}

interface PartHeaders {
  name: string | null;
  filename: string | null;
  contentType: string | null;
}

/** Content-Disposition parameter, handling the quoted and bare forms. */
function dispositionParam(disposition: string, key: string): string | null {
  const pattern = new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*("([^"]*)"|[^;]*)`, "i");
  const match = pattern.exec(disposition);
  if (!match) return null;
  const value = match[2] !== undefined ? match[2] : (match[1] ?? "").trim();
  return value.length > 0 ? value : null;
}

function parsePartHeaders(raw: string): PartHeaders {
  let name: string | null = null;
  let filename: string | null = null;
  let contentType: string | null = null;

  for (const line of raw.split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const header = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (header === "content-disposition") {
      name = dispositionParam(value, "name");
      filename = dispositionParam(value, "filename");
    } else if (header === "content-type") {
      contentType = value;
    }
  }
  return { name, filename, contentType };
}

export interface ParseMultipartInput {
  body: ReadableStream<Uint8Array>;
  contentType: string | null;
  /** Combined cap across every non-file field value. */
  maxFieldBytes: number;
  maxFieldCount: number;
}

/**
 * Walk the form up to and including the `file` part. Fields after `file` are
 * not read — S3 ignores them, and reading past the content would mean
 * buffering it.
 */
export async function parseMultipartForm(
  input: ParseMultipartInput,
): Promise<MultipartFormResult> {
  const boundary = parseBoundary(input.contentType);
  if (!boundary) {
    throw new S3Error("InvalidRequest", { Reason: "Missing multipart boundary." });
  }

  const encoder = new TextEncoder();
  const delimiter = encoder.encode(`\r\n--${boundary}`);
  const firstDelimiter = encoder.encode(`--${boundary}`);

  const cursor = new BodyCursor(input.body.getReader());
  const fields = new Map<string, string>();
  let fieldBytes = 0;

  // Skip the preamble and land just past the first boundary line.
  const start = await cursor.findWithin(firstDelimiter, input.maxFieldBytes);
  if (start === -1) {
    await cursor.cancel();
    throw new S3Error("InvalidRequest", { Reason: "Malformed multipart body." });
  }
  cursor.consume(start + firstDelimiter.length);

  for (;;) {
    // After a boundary comes either "\r\n" (another part) or "--" (the end).
    if (!(await cursor.ensure(2))) {
      await cursor.cancel();
      throw new S3Error("InvalidRequest", { Reason: "Truncated multipart body." });
    }
    const marker = cursor.buffered.subarray(0, 2);
    if (marker[0] === DASH_DASH[0] && marker[1] === DASH_DASH[1]) {
      await cursor.cancel();
      return { fields, file: null };
    }
    if (marker[0] !== CRLF[0] || marker[1] !== CRLF[1]) {
      await cursor.cancel();
      throw new S3Error("InvalidRequest", { Reason: "Malformed multipart boundary." });
    }
    cursor.consume(2);

    const headerEnd = await cursor.findWithin(CRLF_CRLF, input.maxFieldBytes);
    if (headerEnd === -1) {
      await cursor.cancel();
      throw new S3Error("InvalidRequest", { Reason: "Malformed multipart part headers." });
    }
    const headerBytes = cursor.consume(headerEnd);
    cursor.consume(CRLF_CRLF.length);
    const headers = parsePartHeaders(new TextDecoder().decode(headerBytes));

    if (!headers.name) {
      await cursor.cancel();
      throw new S3Error("InvalidRequest", { Reason: "Multipart part is missing a name." });
    }
    const fieldName = headers.name.toLowerCase();

    if (fieldName === "file") {
      return {
        fields,
        file: {
          filename: headers.filename,
          contentType: headers.contentType,
          stream: fileStream(cursor, delimiter),
        },
      };
    }

    if (fields.size >= input.maxFieldCount) {
      await cursor.cancel();
      throw new S3Error("InvalidRequest", { Reason: "Too many form fields." });
    }

    const valueEnd = await cursor.findWithin(delimiter, input.maxFieldBytes - fieldBytes);
    if (valueEnd === -1) {
      await cursor.cancel();
      throw new S3Error("EntityTooLarge");
    }
    const valueBytes = cursor.consume(valueEnd);
    fieldBytes += valueBytes.length;
    if (fieldBytes > input.maxFieldBytes) {
      await cursor.cancel();
      throw new S3Error("EntityTooLarge");
    }
    // A repeated field keeps its first value, matching S3.
    if (!fields.has(fieldName)) {
      fields.set(fieldName, new TextDecoder().decode(valueBytes));
    }
    cursor.consume(delimiter.length);
  }
}

/**
 * Stream the file part, stopping at the closing boundary.
 *
 * The delimiter can straddle two chunks, so bytes are only released once
 * enough lookahead has arrived to rule out a partial match — hence the
 * retained tail of `delimiter.length - 1` bytes.
 */
function fileStream(cursor: BodyCursor, delimiter: Uint8Array): ReadableStream<Uint8Array> {
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      for (;;) {
        const found = indexOf(cursor.buffered, delimiter);
        if (found !== -1) {
          finished = true;
          const tail = cursor.consume(found);
          if (tail.length > 0) controller.enqueue(new Uint8Array(tail));
          await cursor.cancel();
          controller.close();
          return;
        }

        const safe = cursor.buffered.length - (delimiter.length - 1);
        if (safe > 0) {
          controller.enqueue(new Uint8Array(cursor.consume(safe)));
          return;
        }

        if (!(await cursor.pull())) {
          // Body ended without a closing boundary — emit nothing rather than
          // silently accepting a truncated object.
          finished = true;
          controller.error(
            new S3Error("InvalidRequest", { Reason: "Truncated multipart body." }),
          );
          return;
        }
      }
    },
    async cancel(reason) {
      finished = true;
      await cursor.cancel(reason);
    },
  });
}
