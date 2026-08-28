import { describe, expect, test } from "bun:test";
import { createCipheriv } from "node:crypto";
import {
  counterBlockAt,
  decryptStream,
  encryptStream,
  generateDataKey,
  generateIv,
  DATA_KEY_BYTES,
  IV_BYTES,
} from "../../apps/server/src/security/object-crypto.ts";

const KEY = Buffer.alloc(32, 7);
const IV = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");

function streamOf(data: Uint8Array, chunkSize = 4096): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.length) {
        controller.close();
        return;
      }
      controller.enqueue(data.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Reference ciphertext, produced in one shot by the platform cipher. */
function referenceEncrypt(plaintext: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-ctr", KEY, IV);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function sample(length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = (i * 37 + 11) % 256;
  return out;
}

describe("key and IV generation", () => {
  test("produces the documented sizes", () => {
    expect(generateDataKey()).toHaveLength(DATA_KEY_BYTES);
    expect(generateIv()).toHaveLength(IV_BYTES);
  });

  test("does not repeat", () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateDataKey().toString("hex")));
    const ivs = new Set(Array.from({ length: 50 }, () => generateIv().toString("hex")));
    expect(keys.size).toBe(50);
    expect(ivs.size).toBe(50);
  });
});

describe("counterBlockAt", () => {
  test("offset 0 leaves the IV untouched", () => {
    expect(counterBlockAt(IV, 0).toString("hex")).toBe(IV.toString("hex"));
  });

  test("advances once per 16-byte block, not per byte", () => {
    // Every offset inside the first block maps to the unincremented counter.
    for (const offset of [0, 1, 15]) {
      expect(counterBlockAt(IV, offset).toString("hex")).toBe(IV.toString("hex"));
    }
    // The second block is the IV plus one.
    expect(counterBlockAt(IV, 16).toString("hex")).toBe("000102030405060708090a0b0c0d0e10");
    expect(counterBlockAt(IV, 31).toString("hex")).toBe("000102030405060708090a0b0c0d0e10");
    expect(counterBlockAt(IV, 32).toString("hex")).toBe("000102030405060708090a0b0c0d0e11");
  });

  test("carries across byte boundaries", () => {
    const iv = Buffer.from("000000000000000000000000000000ff", "hex");
    expect(counterBlockAt(iv, 16).toString("hex")).toBe("00000000000000000000000000000100");

    const rollover = Buffer.from("00000000000000000000000000ffffff", "hex");
    expect(counterBlockAt(rollover, 16).toString("hex")).toBe("00000000000000000000000001000000");
  });

  test("wraps within the 128-bit block rather than overflowing", () => {
    const maxed = Buffer.alloc(16, 0xff);
    expect(counterBlockAt(maxed, 16).toString("hex")).toBe("0".repeat(32));
  });

  test("handles a large offset without losing precision", () => {
    // 4 GiB in, well past 32-bit range.
    const offset = 4 * 1024 * 1024 * 1024;
    const expected = Buffer.from(IV);
    // 4 GiB / 16 = 0x10000000 added to the low 4 bytes.
    expected.writeUInt32BE(expected.readUInt32BE(12) + 0x1000_0000, 12);
    expect(counterBlockAt(IV, offset).toString("hex")).toBe(expected.toString("hex"));
  });

  test("rejects a negative or non-integer offset", () => {
    expect(() => counterBlockAt(IV, -1)).toThrow(RangeError);
    expect(() => counterBlockAt(IV, 1.5)).toThrow(RangeError);
  });
});

describe("encryptStream", () => {
  test("matches the platform cipher and preserves length", async () => {
    const plaintext = sample(10_000);
    const encrypted = await drain(encryptStream(KEY, IV, streamOf(plaintext)));
    expect(encrypted.length).toBe(plaintext.length);
    expect(encrypted.equals(referenceEncrypt(plaintext))).toBe(true);
  });

  test("produces identical output no matter how the input is chunked", async () => {
    const plaintext = sample(5000);
    const expected = referenceEncrypt(plaintext);
    for (const chunkSize of [1, 3, 16, 17, 1024, 5000]) {
      const encrypted = await drain(encryptStream(KEY, IV, streamOf(plaintext, chunkSize)));
      expect(encrypted.equals(expected)).toBe(true);
    }
  });

  test("handles an empty object", async () => {
    const encrypted = await drain(encryptStream(KEY, IV, streamOf(Buffer.alloc(0))));
    expect(encrypted.length).toBe(0);
  });
});

describe("decryptStream", () => {
  test("round-trips a whole object", async () => {
    const plaintext = sample(10_000);
    const encrypted = await drain(encryptStream(KEY, IV, streamOf(plaintext)));
    const decrypted = await drain(decryptStream(KEY, IV, streamOf(encrypted)));
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  test("decrypts a range starting on a block boundary", async () => {
    const plaintext = sample(4096);
    const encrypted = referenceEncrypt(plaintext);
    const start = 1024;
    const slice = encrypted.subarray(start, start + 512);
    const decrypted = await drain(decryptStream(KEY, IV, streamOf(slice), start));
    expect(decrypted.equals(plaintext.subarray(start, start + 512))).toBe(true);
  });

  test("decrypts a range starting mid-block, which is the case that breaks naive seeking", async () => {
    const plaintext = sample(4096);
    const encrypted = referenceEncrypt(plaintext);
    // Deliberately not multiples of 16.
    for (const start of [1, 5, 15, 17, 33, 100, 1001, 2047]) {
      const length = 300;
      const slice = encrypted.subarray(start, start + length);
      const decrypted = await drain(decryptStream(KEY, IV, streamOf(slice), start));
      expect(decrypted.equals(plaintext.subarray(start, start + length))).toBe(true);
    }
  });

  test("decrypts every offset in the first two blocks correctly", async () => {
    const plaintext = sample(256);
    const encrypted = referenceEncrypt(plaintext);
    for (let start = 0; start < 32; start++) {
      const slice = encrypted.subarray(start);
      const decrypted = await drain(decryptStream(KEY, IV, streamOf(slice), start));
      expect(decrypted.equals(plaintext.subarray(start))).toBe(true);
    }
  });

  test("a ranged decrypt is unaffected by how the ciphertext is chunked", async () => {
    const plaintext = sample(8192);
    const encrypted = referenceEncrypt(plaintext);
    const start = 777;
    const length = 1234;
    const slice = encrypted.subarray(start, start + length);
    for (const chunkSize of [1, 7, 16, 64, 4096]) {
      const decrypted = await drain(decryptStream(KEY, IV, streamOf(slice, chunkSize), start));
      expect(decrypted.equals(plaintext.subarray(start, start + length))).toBe(true);
    }
  });

  test("a suffix range reaching the end of the object decrypts", async () => {
    const plaintext = sample(3333);
    const encrypted = referenceEncrypt(plaintext);
    const start = 3000;
    const decrypted = await drain(decryptStream(KEY, IV, streamOf(encrypted.subarray(start)), start));
    expect(decrypted.equals(plaintext.subarray(start))).toBe(true);
  });

  test("the wrong key yields garbage rather than the plaintext", async () => {
    const plaintext = sample(1024);
    const encrypted = referenceEncrypt(plaintext);
    const wrong = Buffer.alloc(32, 9);
    const decrypted = await drain(decryptStream(wrong, IV, streamOf(encrypted)));
    expect(decrypted.length).toBe(plaintext.length);
    expect(decrypted.equals(plaintext)).toBe(false);
  });

  test("the wrong IV yields garbage rather than the plaintext", async () => {
    const plaintext = sample(1024);
    const encrypted = referenceEncrypt(plaintext);
    const wrongIv = Buffer.alloc(16, 1);
    const decrypted = await drain(decryptStream(KEY, wrongIv, streamOf(encrypted)));
    expect(decrypted.equals(plaintext)).toBe(false);
  });

  test("decrypting at the wrong offset yields garbage", async () => {
    const plaintext = sample(1024);
    const encrypted = referenceEncrypt(plaintext);
    const start = 256;
    const slice = encrypted.subarray(start, start + 128);
    const decrypted = await drain(decryptStream(KEY, IV, streamOf(slice), start + 1));
    expect(decrypted.equals(plaintext.subarray(start, start + 128))).toBe(false);
  });
});
