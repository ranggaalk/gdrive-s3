// AWS Signature Version 4A primitives — the asymmetric variant of SigV4.
//
// SigV4A keeps the SigV4 canonical request untouched but swaps the symmetric
// HMAC signature for ECDSA over NIST P-256, and drops the region from the
// credential scope so one signature can be presented to several regions. The
// signing key pair is *derived* from the same access key id + secret access key
// a SigV4 client already holds, so this needs no new credential material at
// rest — `s3_credentials` stays exactly as it is.
//
// Kept free of I/O so it can be unit-tested on its own, mirroring the split
// that sigv4-canonical.ts already uses.

import {
  createECDH,
  createHmac,
  createPublicKey,
  createVerify,
  type KeyObject,
} from "node:crypto";

export const ALGORITHM_V4A = "AWS4-ECDSA-P256-SHA256";
export const REGION_SET_HEADER = "x-amz-region-set";
export const REGION_SET_PARAM = "X-Amz-Region-Set";

/**
 * The order of the P-256 curve minus two. A derived candidate scalar greater
 * than this is discarded and the counter incremented, so that `candidate + 1`
 * always lands in [1, n-1] — the valid private-key range.
 */
const N_MINUS_2 = Buffer.from(
  "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc63254f",
  "hex",
);

const MAX_DERIVATION_TRIALS = 254;

/** NIST SP 800-108 counter-mode KDF block: i ‖ label ‖ 0x00 ‖ context ‖ counter ‖ L. */
function fixedInputBlock(accessKeyId: string, counter: number): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x01]), // i = 1, big-endian
    Buffer.from(ALGORITHM_V4A, "utf8"), // label
    Buffer.from([0x00]), // label/context separator
    Buffer.from(accessKeyId, "utf8"), // context
    Buffer.from([counter]),
    Buffer.from([0x00, 0x00, 0x01, 0x00]), // L = 256 bits, big-endian
  ]);
}

/** candidate + 1, big-endian. The caller has already rejected candidates above
 *  n-2, so the addition can never carry out of the top byte. */
function addOne(value: Buffer): Buffer {
  const out = Buffer.from(value);
  for (let index = out.length - 1; index >= 0; index--) {
    if (out[index] === 0xff) {
      out[index] = 0x00;
      continue;
    }
    out[index] = out[index]! + 1;
    break;
  }
  return out;
}

/**
 * Derive the P-256 private scalar for a credential pair.
 *
 * NOTE on the retry path: when a candidate exceeds n-2 the next trial hashes
 * the *concatenation* of every fixed-input block so far rather than just the
 * new one. That looks like an off-by-one, and it is — but it is what
 * `@smithy/signature-v4a` does, which is the implementation the AWS SDK for
 * JavaScript signs with, so matching it is what keeps real clients working.
 * A first-trial candidate exceeds n-2 with probability ~2^-32, so this branch
 * effectively never runs; it is here for completeness, not for throughput.
 */
export function deriveSigV4aPrivateKey(accessKeyId: string, secretAccessKey: string): Buffer {
  const hmacKey = Buffer.from(`AWS4A${secretAccessKey}`, "utf8");
  let input = Buffer.alloc(0);
  for (let counter = 1; counter < MAX_DERIVATION_TRIALS; counter++) {
    input = Buffer.concat([input, fixedInputBlock(accessKeyId, counter)]);
    const candidate = createHmac("sha256", hmacKey).update(input).digest();
    if (candidate.compare(N_MINUS_2) > 0) continue;
    return addOne(candidate);
  }
  throw new Error("SigV4A key derivation exceeded the maximum trial count");
}

/**
 * Public key for a derived scalar. The scalar multiplication is delegated to
 * OpenSSL through ECDH rather than hand-rolled: `setPrivateKey` computes the
 * public point, which we then hand back as a JWK.
 */
export function sigV4aPublicKey(privateScalar: Buffer): KeyObject {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(privateScalar);
  const point = ecdh.getPublicKey(); // 0x04 ‖ X(32) ‖ Y(32)
  return createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
}

/** SigV4A credential scope: no region, unlike SigV4. */
export function sigV4aScope(dateStamp: string, service: string): string {
  return `${dateStamp}/${service}/aws4_request`;
}

/**
 * A SigV4A signature commits to a *set* of regions. We accept the request when
 * the set is the `*` wildcard or explicitly names the region this gateway
 * serves; anything else was signed for somewhere that is not us.
 */
export function regionSetMatches(regionSet: string, region: string): boolean {
  const entries = regionSet
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return false;
  return entries.some((entry) => entry === "*" || entry === region);
}

/** The wire signature is hex-encoded ASN.1 DER, so its length varies (~70-72
 *  bytes) instead of the fixed 64 hex chars a SigV4 signature has. */
export function isValidDerSignatureHex(value: string): boolean {
  return value.length >= 16 && value.length <= 256 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}

/**
 * Verify an ECDSA signature over the string-to-sign. Node hashes the message
 * with SHA-256 internally, which matches SigV4A signing the SHA-256 digest of
 * the string-to-sign.
 */
export function verifySigV4aSignature(input: {
  accessKeyId: string;
  secretAccessKey: string;
  stringToSign: string;
  signatureDer: Buffer;
}): boolean {
  const scalar = deriveSigV4aPrivateKey(input.accessKeyId, input.secretAccessKey);
  try {
    const publicKey = sigV4aPublicKey(scalar);
    return createVerify("SHA256").update(input.stringToSign, "utf8").verify(publicKey, input.signatureDer);
  } catch {
    // A malformed DER body makes OpenSSL throw rather than return false.
    return false;
  } finally {
    scalar.fill(0);
  }
}
