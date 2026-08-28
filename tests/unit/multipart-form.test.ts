import { describe, expect, test } from "bun:test";
import {
  parseBoundary,
  parseMultipartForm,
} from "../../apps/server/src/s3/multipart-form.ts";
import { S3Error } from "../../apps/server/src/s3/errors.ts";

const BOUNDARY = "----DriveS3TestBoundary";

interface FormPart {
  name: string;
  value: string | Uint8Array;
  filename?: string;
  contentType?: string;
}

function buildBody(parts: FormPart[], options: { close?: boolean } = {}): Uint8Array {
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const part of parts) {
    let headers = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) headers += `; filename="${part.filename}"`;
    headers += "\r\n";
    if (part.contentType) headers += `Content-Type: ${part.contentType}\r\n`;
    headers += "\r\n";
    chunks.push(encoder.encode(headers));
    chunks.push(typeof part.value === "string" ? encoder.encode(part.value) : part.value);
    chunks.push(encoder.encode("\r\n"));
  }
  if (options.close !== false) chunks.push(encoder.encode(`--${BOUNDARY}--\r\n`));
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Feed the body in fixed-size slices so delimiters land across chunks. */
function streamOf(body: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= body.length) {
        controller.close();
        return;
      }
      controller.enqueue(body.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

function parse(body: Uint8Array, chunkSize = 4096) {
  return parseMultipartForm({
    body: streamOf(body, chunkSize),
    contentType: `multipart/form-data; boundary=${BOUNDARY}`,
    maxFieldBytes: 64 * 1024,
    maxFieldCount: 40,
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

describe("parseBoundary", () => {
  test("reads the boundary in quoted and bare forms", () => {
    expect(parseBoundary("multipart/form-data; boundary=abc")).toBe("abc");
    expect(parseBoundary('multipart/form-data; boundary="a b c"')).toBe("a b c");
    expect(parseBoundary("MULTIPART/FORM-DATA; BOUNDARY=abc")).toBe("abc");
    expect(parseBoundary("multipart/form-data; charset=utf-8; boundary=xyz")).toBe("xyz");
  });

  test("returns null for anything that is not a multipart form", () => {
    expect(parseBoundary(null)).toBeNull();
    expect(parseBoundary("application/json")).toBeNull();
    expect(parseBoundary("multipart/form-data")).toBeNull();
    expect(parseBoundary("multipart/form-data; boundary=")).toBeNull();
  });
});

describe("parseMultipartForm", () => {
  test("collects leading fields and streams the file", async () => {
    const body = buildBody([
      { name: "key", value: "uploads/report.pdf" },
      { name: "acl", value: "private" },
      { name: "file", value: "the file contents", filename: "r.pdf", contentType: "text/plain" },
    ]);
    const form = await parse(body);
    expect(form.fields.get("key")).toBe("uploads/report.pdf");
    expect(form.fields.get("acl")).toBe("private");
    expect(form.file?.filename).toBe("r.pdf");
    expect(form.file?.contentType).toBe("text/plain");
    expect(new TextDecoder().decode(await drain(form.file!.stream))).toBe("the file contents");
  });

  test("lowercases field names", async () => {
    const body = buildBody([
      { name: "Content-Type", value: "text/plain" },
      { name: "file", value: "x", filename: "a.txt" },
    ]);
    const form = await parse(body);
    expect(form.fields.get("content-type")).toBe("text/plain");
  });

  test("recovers the file whole no matter how the body is chunked", async () => {
    // 40 KiB of varied bytes, so a naive scanner that drops its lookahead tail
    // corrupts the payload rather than merely truncating it.
    const content = new Uint8Array(40 * 1024);
    for (let i = 0; i < content.length; i++) content[i] = (i * 31) % 251;
    const body = buildBody([
      { name: "key", value: "big.bin" },
      { name: "file", value: content, filename: "big.bin" },
    ]);

    for (const chunkSize of [1, 2, 3, 7, 13, 64, 1000, 4096, body.length]) {
      const form = await parse(body, chunkSize);
      const received = await drain(form.file!.stream);
      expect(received.length).toBe(content.length);
      expect(Buffer.from(received).equals(Buffer.from(content))).toBe(true);
    }
  });

  test("handles content that contains a near-miss of the boundary", async () => {
    // The real delimiter is "\r\n--BOUNDARY"; this content holds prefixes of it
    // that must not terminate the part early.
    const tricky = `head\r\n--${BOUNDARY.slice(0, -1)}\r\nmiddle\r\n--not-it\r\ntail`;
    const body = buildBody([
      { name: "key", value: "k" },
      { name: "file", value: tricky, filename: "t.txt" },
    ]);
    for (const chunkSize of [1, 5, 17, 4096]) {
      const form = await parse(body, chunkSize);
      expect(new TextDecoder().decode(await drain(form.file!.stream))).toBe(tricky);
    }
  });

  test("handles an empty file part", async () => {
    const body = buildBody([
      { name: "key", value: "k" },
      { name: "file", value: "", filename: "empty.txt" },
    ]);
    const form = await parse(body);
    expect((await drain(form.file!.stream)).length).toBe(0);
  });

  test("stops at the file, ignoring anything after it", async () => {
    const body = buildBody([
      { name: "key", value: "k" },
      { name: "file", value: "content", filename: "a.txt" },
      { name: "trailing", value: "ignored" },
    ]);
    const form = await parse(body);
    expect(new TextDecoder().decode(await drain(form.file!.stream))).toBe("content");
    expect(form.fields.has("trailing")).toBe(false);
  });

  test("returns no file when the form has none", async () => {
    const body = buildBody([{ name: "key", value: "k" }]);
    const form = await parse(body);
    expect(form.file).toBeNull();
    expect(form.fields.get("key")).toBe("k");
  });

  test("keeps the first value when a field repeats", async () => {
    const body = buildBody([
      { name: "key", value: "first" },
      { name: "key", value: "second" },
      { name: "file", value: "x", filename: "a" },
    ]);
    const form = await parse(body);
    expect(form.fields.get("key")).toBe("first");
  });

  test("errors on a body truncated before the closing boundary", async () => {
    const body = buildBody(
      [
        { name: "key", value: "k" },
        { name: "file", value: "partial content", filename: "a.txt" },
      ],
      { close: false },
    );
    const form = await parse(body);
    await expect(drain(form.file!.stream)).rejects.toThrow(S3Error);
  });

  test("rejects a missing boundary", async () => {
    await expect(
      parseMultipartForm({
        body: streamOf(new Uint8Array(0), 16),
        contentType: "application/json",
        maxFieldBytes: 1024,
        maxFieldCount: 10,
      }),
    ).rejects.toThrow(S3Error);
  });

  test("rejects a field value beyond the byte cap", async () => {
    const body = buildBody([
      { name: "key", value: "x".repeat(5000) },
      { name: "file", value: "y", filename: "a" },
    ]);
    await expect(
      parseMultipartForm({
        body: streamOf(body, 512),
        contentType: `multipart/form-data; boundary=${BOUNDARY}`,
        maxFieldBytes: 1024,
        maxFieldCount: 40,
      }),
    ).rejects.toThrow(S3Error);
  });

  test("rejects a form with more fields than allowed", async () => {
    const parts: FormPart[] = Array.from({ length: 12 }, (_, i) => ({
      name: `f${i}`,
      value: "v",
    }));
    parts.push({ name: "file", value: "x", filename: "a" });
    await expect(
      parseMultipartForm({
        body: streamOf(buildBody(parts), 256),
        contentType: `multipart/form-data; boundary=${BOUNDARY}`,
        maxFieldBytes: 64 * 1024,
        maxFieldCount: 5,
      }),
    ).rejects.toThrow(S3Error);
  });

  test("rejects a part with no name", async () => {
    const raw = new TextEncoder().encode(
      `--${BOUNDARY}\r\nContent-Disposition: form-data\r\n\r\nvalue\r\n--${BOUNDARY}--\r\n`,
    );
    await expect(parse(raw)).rejects.toThrow(S3Error);
  });
});
