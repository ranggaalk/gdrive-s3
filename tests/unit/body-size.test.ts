import { describe, expect, test } from "bun:test";
import {
  BodyTooLargeError,
  readBoundedJson,
  readBoundedText,
} from "../../apps/server/src/util/body-size.ts";

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("readBoundedText", () => {
  test("assembles chunks under the limit", async () => {
    const stream = makeStream(["hello ", "world"]);
    expect(await readBoundedText(stream, 32)).toBe("hello world");
  });

  test("returns empty string on null body", async () => {
    expect(await readBoundedText(null, 32)).toBe("");
  });

  test("throws BodyTooLargeError when limit crossed", async () => {
    const stream = makeStream(["a".repeat(100)]);
    await expect(readBoundedText(stream, 10)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe("readBoundedJson", () => {
  test("returns parsed object for valid payloads", async () => {
    const req = new Request("http://x/", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
    });
    expect(await readBoundedJson<{ hello: string }>(req, 1024)).toEqual({ hello: "world" });
  });

  test("returns null on malformed JSON", async () => {
    const req = new Request("http://x/", { method: "POST", body: "{not json" });
    expect(await readBoundedJson(req, 1024)).toBeNull();
  });

  test("propagates BodyTooLargeError past the limit", async () => {
    const req = new Request("http://x/", {
      method: "POST",
      body: JSON.stringify({ big: "x".repeat(4096) }),
    });
    await expect(readBoundedJson(req, 128)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});
