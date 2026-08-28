import { describe, expect, test } from "bun:test";
import { createECDH, createPrivateKey, createSign, createVerify } from "node:crypto";
import {
  ALGORITHM_V4A,
  deriveSigV4aPrivateKey,
  isValidDerSignatureHex,
  regionSetMatches,
  sigV4aPublicKey,
  sigV4aScope,
  verifySigV4aSignature,
} from "../../apps/server/src/auth/sigv4a.ts";

const ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
const SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

/** The P-256 group order. A private scalar must land in [1, n-1]. */
const CURVE_ORDER = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
);

/**
 * Independent transcription of the upstream derivation in
 * `@smithy/signature-v4a` (`getSigV4aSigningKey`), kept in the original
 * string-and-array form rather than delegating to the implementation under
 * test. If either version is mis-transcribed the two disagree, which is the
 * whole point of having it here.
 */
function upstreamDeriveSigningKey(accessKey: string, secretKey: string): Uint8Array {
  const ONE_AS_4_BYTES = [0x00, 0x00, 0x00, 0x01];
  const TWOFIFTYSIX_AS_4_BYTES = [0x00, 0x00, 0x01, 0x00];
  const N_MINUS_TWO = [
    0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x4f,
  ];

  const isBiggerThanNMinus2 = (value: Uint8Array): boolean => {
    for (let index = 0; index < value.length; index++) {
      if (value[index]! > N_MINUS_TWO[index]!) return true;
      if (value[index]! < N_MINUS_TWO[index]!) return false;
    }
    return false;
  };

  const addOneToArray = (value: Uint8Array): Uint8Array => {
    const output = new Uint8Array(32);
    let carry = 1;
    for (let index = value.length - 1; index >= 0; index--) {
      const next = (value[index]! + carry) % 256;
      carry = next < value[index]! ? 1 : 0;
      output[index] = next;
    }
    return output;
  };

  const buildFixedInputBuffer = (bufferInput: string, key: string, counter: number): string => {
    let outputBuffer = bufferInput;
    outputBuffer += ONE_AS_4_BYTES.map((value) => String.fromCharCode(value)).join("");
    outputBuffer += ALGORITHM_V4A;
    outputBuffer += String.fromCharCode(0x00);
    outputBuffer += key;
    outputBuffer += String.fromCharCode(counter);
    outputBuffer += TWOFIFTYSIX_AS_4_BYTES.map((value) => String.fromCharCode(value)).join("");
    return outputBuffer;
  };

  const hmacKey = new TextEncoder().encode(`AWS4A${secretKey}`);
  let outputBufferWriter = "";
  for (let trial = 1; trial < 254; trial++) {
    outputBufferWriter = buildFixedInputBuffer(outputBufferWriter, accessKey, trial);
    const hasher = new Bun.CryptoHasher("sha256", hmacKey);
    hasher.update(new TextEncoder().encode(outputBufferWriter));
    const hashed = new Uint8Array(hasher.digest());
    if (isBiggerThanNMinus2(hashed)) continue;
    return addOneToArray(hashed);
  }
  throw new Error("derivation exceeded trials");
}

/** Rebuild a signing-capable key object from a derived scalar (tests only —
 *  the gateway never signs with SigV4A, it only verifies). */
function privateKeyFromScalar(scalar: Buffer) {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(scalar);
  const point = ecdh.getPublicKey();
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: scalar.toString("base64url"),
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
}

describe("SigV4A key derivation", () => {
  test("matches the upstream AWS SDK derivation", () => {
    const mine = deriveSigV4aPrivateKey(ACCESS_KEY, SECRET_KEY);
    const upstream = upstreamDeriveSigningKey(ACCESS_KEY, SECRET_KEY);
    expect(mine.toString("hex")).toBe(Buffer.from(upstream).toString("hex"));
  });

  test("matches upstream across a spread of credential shapes", () => {
    const pairs: Array<[string, string]> = [
      ["AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"],
      ["AKIAIOSFODNN7EXAMPLE", "short"],
      ["A", "b"],
      ["AKIA0000000000000000", "0123456789012345678901234567890123456789"],
      // A secret longer than the 64-byte HMAC block, which upstream sizes its
      // key buffer for explicitly.
      ["AKIALONGSECRETEXAMPLE", "x".repeat(100)],
    ];
    for (const [access, secret] of pairs) {
      expect(deriveSigV4aPrivateKey(access, secret).toString("hex")).toBe(
        Buffer.from(upstreamDeriveSigningKey(access, secret)).toString("hex"),
      );
    }
  });

  test("is deterministic and bound to both halves of the credential", () => {
    const base = deriveSigV4aPrivateKey(ACCESS_KEY, SECRET_KEY);
    expect(deriveSigV4aPrivateKey(ACCESS_KEY, SECRET_KEY).toString("hex")).toBe(
      base.toString("hex"),
    );
    expect(deriveSigV4aPrivateKey("AKIAOTHEREXAMPLE0000", SECRET_KEY).toString("hex")).not.toBe(
      base.toString("hex"),
    );
    expect(deriveSigV4aPrivateKey(ACCESS_KEY, "different-secret").toString("hex")).not.toBe(
      base.toString("hex"),
    );
  });

  test("produces a scalar inside the valid private-key range", () => {
    for (let i = 0; i < 32; i++) {
      const scalar = deriveSigV4aPrivateKey(`AKIA${String(i).padStart(16, "0")}`, SECRET_KEY);
      expect(scalar.length).toBe(32);
      const value = BigInt(`0x${scalar.toString("hex")}`);
      expect(value > 0n).toBe(true);
      expect(value < CURVE_ORDER).toBe(true);
    }
  });
});

describe("SigV4A public key", () => {
  test("round-trips a signature made with the derived private key", () => {
    const scalar = deriveSigV4aPrivateKey(ACCESS_KEY, SECRET_KEY);
    const publicKey = sigV4aPublicKey(scalar);
    const message = "AWS4-ECDSA-P256-SHA256\n20260828T040506Z\n20260828/s3/aws4_request\ndeadbeef";
    const signature = createSign("SHA256").update(message).sign(privateKeyFromScalar(scalar));
    expect(createVerify("SHA256").update(message).verify(publicKey, signature)).toBe(true);
  });

  test("is stable across calls for the same scalar", () => {
    const scalar = deriveSigV4aPrivateKey(ACCESS_KEY, SECRET_KEY);
    const first = sigV4aPublicKey(scalar).export({ format: "jwk" });
    const second = sigV4aPublicKey(scalar).export({ format: "jwk" });
    expect(first).toEqual(second);
  });
});

describe("verifySigV4aSignature", () => {
  const stringToSign = [
    ALGORITHM_V4A,
    "20260828T040506Z",
    "20260828/s3/aws4_request",
    "0".repeat(64),
  ].join("\n");

  function sign(access: string, secret: string, message: string): Buffer {
    const scalar = deriveSigV4aPrivateKey(access, secret);
    return createSign("SHA256").update(message).sign(privateKeyFromScalar(scalar));
  }

  test("accepts a signature made with the matching credential", () => {
    expect(
      verifySigV4aSignature({
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET_KEY,
        stringToSign,
        signatureDer: sign(ACCESS_KEY, SECRET_KEY, stringToSign),
      }),
    ).toBe(true);
  });

  test("rejects a signature over a different string-to-sign", () => {
    expect(
      verifySigV4aSignature({
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET_KEY,
        stringToSign,
        signatureDer: sign(ACCESS_KEY, SECRET_KEY, `${stringToSign}-tampered`),
      }),
    ).toBe(false);
  });

  test("rejects a signature made with the wrong secret", () => {
    expect(
      verifySigV4aSignature({
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET_KEY,
        stringToSign,
        signatureDer: sign(ACCESS_KEY, "some-other-secret", stringToSign),
      }),
    ).toBe(false);
  });

  test("rejects a signature bound to a different access key id", () => {
    expect(
      verifySigV4aSignature({
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET_KEY,
        stringToSign,
        signatureDer: sign("AKIAOTHEREXAMPLE0000", SECRET_KEY, stringToSign),
      }),
    ).toBe(false);
  });

  test("returns false rather than throwing on a malformed DER body", () => {
    expect(
      verifySigV4aSignature({
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET_KEY,
        stringToSign,
        signatureDer: Buffer.from("not-valid-der-at-all", "utf8"),
      }),
    ).toBe(false);
  });
});

describe("SigV4A scope and region set", () => {
  test("scope omits the region that SigV4 carries", () => {
    expect(sigV4aScope("20260828", "s3")).toBe("20260828/s3/aws4_request");
  });

  test("region set accepts the wildcard, the exact region, and lists containing it", () => {
    expect(regionSetMatches("*", "us-east-1")).toBe(true);
    expect(regionSetMatches("us-east-1", "us-east-1")).toBe(true);
    expect(regionSetMatches("eu-west-1, us-east-1", "us-east-1")).toBe(true);
    expect(regionSetMatches("us-east-1,eu-west-1", "us-east-1")).toBe(true);
  });

  test("region set rejects other regions and empty values", () => {
    expect(regionSetMatches("eu-west-1", "us-east-1")).toBe(false);
    expect(regionSetMatches("", "us-east-1")).toBe(false);
    expect(regionSetMatches("   ", "us-east-1")).toBe(false);
    expect(regionSetMatches(",,", "us-east-1")).toBe(false);
    // Substring lookalikes must not pass.
    expect(regionSetMatches("us-east-11", "us-east-1")).toBe(false);
  });
});

describe("DER signature hex validation", () => {
  test("accepts realistic DER signature lengths", () => {
    const scalar = deriveSigV4aPrivateKey(ACCESS_KEY, SECRET_KEY);
    const der = createSign("SHA256").update("x").sign(privateKeyFromScalar(scalar));
    expect(isValidDerSignatureHex(der.toString("hex"))).toBe(true);
  });

  test("rejects odd lengths, non-hex, and out-of-range sizes", () => {
    expect(isValidDerSignatureHex("abc")).toBe(false);
    expect(isValidDerSignatureHex("zzzzzzzzzzzzzzzz")).toBe(false);
    expect(isValidDerSignatureHex("")).toBe(false);
    expect(isValidDerSignatureHex("ab".repeat(200))).toBe(false);
  });
});
