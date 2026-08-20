export const STREAMING_SIGNED_PAYLOAD = "STREAMING-AWS4-HMAC-SHA256-PAYLOAD";
export type S3PayloadMode =
  | { kind: "digest"; sha256Hex: string }
  | { kind: "unsigned" }
  | { kind: "streaming-signed" }
  | { kind: "unsupported"; marker: string };

export function parseS3PayloadMode(value: string | null): S3PayloadMode {
  if (value === null || value === "UNSIGNED-PAYLOAD") return { kind: "unsigned" };
  if (/^[0-9a-f]{64}$/.test(value)) return { kind: "digest", sha256Hex: value };
  if (value === STREAMING_SIGNED_PAYLOAD) return { kind: "streaming-signed" };
  return { kind: "unsupported", marker: value };
}
