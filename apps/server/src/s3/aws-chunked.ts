import { createHmac } from "node:crypto";
import { sha256Hex } from "../auth/sigv4-canonical.ts";
import { S3Error } from "./errors.ts";

const CHUNK_ALGORITHM = "AWS4-HMAC-SHA256-PAYLOAD";
const EMPTY_SHA256 = sha256Hex("");
const MAX_HEADER_BYTES = 8 * 1024;

export interface AwsChunkedAuth {
  signingKey: Buffer;
  seedSignature: string;
  amzDate: string;
  scope: string;
}

export function decodeAwsChunkedBody(
  body: ReadableStream<Uint8Array>,
  auth: AwsChunkedAuth,
  expectedLength: number | null,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let buffer = new Uint8Array();
  let previousSignature = auth.seedSignature;
  let decodedLength = 0;
  let finished = false;

  const append = (chunk: Uint8Array) => {
    const next = new Uint8Array(buffer.byteLength + chunk.byteLength);
    next.set(buffer);
    next.set(chunk, buffer.byteLength);
    buffer = next;
  };

  const ensure = async (length: number): Promise<void> => {
    while (buffer.byteLength < length) {
      const next = await reader.read();
      if (next.done) throw new S3Error("InvalidRequest", { Reason: "Truncated aws-chunked body." });
      if (next.value) append(next.value);
    }
  };

  const readLine = async (): Promise<string> => {
    while (true) {
      for (let index = 0; index + 1 < buffer.byteLength; index++) {
        if (buffer[index] === 13 && buffer[index + 1] === 10) {
          const line = new TextDecoder().decode(buffer.subarray(0, index));
          buffer = buffer.subarray(index + 2);
          return line;
        }
      }
      if (buffer.byteLength > MAX_HEADER_BYTES) {
        throw new S3Error("InvalidRequest", { Reason: "aws-chunked header is too large." });
      }
      const next = await reader.read();
      if (next.done) throw new S3Error("InvalidRequest", { Reason: "Truncated aws-chunked header." });
      if (next.value) append(next.value);
    }
  };

  const verifyChunk = (chunk: Uint8Array, signature: string): void => {
    const stringToSign =
      `${CHUNK_ALGORITHM}\n${auth.amzDate}\n${auth.scope}\n${previousSignature}\n` +
      `${EMPTY_SHA256}\n${sha256Hex(chunk)}`;
    const expected = createHmac("sha256", auth.signingKey)
      .update(stringToSign, "utf8")
      .digest("hex");
    if (signature !== expected) {
      throw new S3Error("SignatureDoesNotMatch");
    }
    previousSignature = signature;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        const line = await readLine();
        const match = /^([0-9a-fA-F]+);chunk-signature=([0-9a-f]{64})$/.exec(line);
        if (!match) throw new S3Error("InvalidRequest", { Reason: "Malformed aws-chunked header." });
        const size = Number.parseInt(match[1]!, 16);
        if (!Number.isSafeInteger(size) || size < 0) {
          throw new S3Error("InvalidRequest", { Reason: "Invalid aws-chunked size." });
        }
        await ensure(size + 2);
        const chunk = buffer.slice(0, size);
        if (buffer[size] !== 13 || buffer[size + 1] !== 10) {
          throw new S3Error("InvalidRequest", { Reason: "Malformed aws-chunked delimiter." });
        }
        buffer = buffer.subarray(size + 2);
        verifyChunk(chunk, match[2]!);
        decodedLength += size;
        if (size === 0) {
          if (expectedLength !== null && decodedLength !== expectedLength) {
            throw new S3Error("InvalidRequest", { Reason: "Decoded content length mismatch." });
          }
          finished = true;
          auth.signingKey.fill(0);
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      } catch (error) {
        finished = true;
        auth.signingKey.fill(0);
        controller.error(error);
      }
    },
    async cancel(reason) {
      finished = true;
      auth.signingKey.fill(0);
      await reader.cancel(reason);
    },
  });
}
