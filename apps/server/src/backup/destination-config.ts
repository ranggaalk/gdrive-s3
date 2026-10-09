// What a user may configure for an S3 or rclone backup destination, and the
// checks it passes before anything is stored or contacted. The parsed forms
// are what config_json holds; secrets never go in it.

import type { AppConfig } from "../config.ts";

export interface S3DestinationConfig {
  /** Scheme and host only, e.g. https://s3.eu-west-1.amazonaws.com */
  endpoint: string;
  region: string;
  bucket: string;
  /** Without leading or trailing slashes; "" for the bucket root. */
  prefix: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  storageClass: string | null;
}

export interface RcloneDestinationConfig {
  remote: string;
  /** Relative to the remote's root, without leading or trailing slashes. */
  path: string;
}

export class DestinationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DestinationInputError";
  }
}

const MAX_LABEL_LENGTH = 100;
const MAX_PREFIX_BYTES = 512;
const REGION_PATTERN = /^[a-z0-9-]{1,32}$/;
// Legacy buckets may hold capitals and underscores; path-style still reaches them.
const BUCKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,254}$/;
const DNS_BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const STORAGE_CLASS_PATTERN = /^[A-Z_]{1,32}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function str(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new DestinationInputError(`${key} must be a string`);
  return value.trim();
}

function requiredStr(raw: Record<string, unknown>, key: string): string {
  const value = str(raw, key);
  if (!value) throw new DestinationInputError(`${key} is required`);
  return value;
}

function label(raw: Record<string, unknown>, fallback: string): string {
  const value = str(raw, "label");
  if (!value) return fallback;
  if (value.length > MAX_LABEL_LENGTH) {
    throw new DestinationInputError(`label must be at most ${MAX_LABEL_LENGTH} characters`);
  }
  if (CONTROL_CHARS.test(value)) throw new DestinationInputError("label contains control characters");
  return value;
}

/**
 * A path under the destination, as slash-separated segments. "." and ".."
 * are refused outright: on a filesystem-backed rclone remote they would climb
 * out of the place the operator meant, and an HTTP client folds them away
 * before an S3 request is even sent.
 */
export function normalizeRelativePath(value: string, key: string, allowLeadingSlash: boolean): string {
  if (!allowLeadingSlash && value.startsWith("/")) {
    throw new DestinationInputError(`${key} must be relative to the remote's root (no leading "/")`);
  }
  const trimmed = value.replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return "";
  if (Buffer.byteLength(trimmed, "utf8") > MAX_PREFIX_BYTES) {
    throw new DestinationInputError(`${key} must be at most ${MAX_PREFIX_BYTES} bytes`);
  }
  if (CONTROL_CHARS.test(trimmed)) throw new DestinationInputError(`${key} contains control characters`);
  for (const segment of trimmed.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new DestinationInputError(`${key} must not contain empty, "." or ".." segments`);
    }
  }
  return trimmed;
}

function bool(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new DestinationInputError(`${key} must be true or false`);
  return value;
}

function asRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DestinationInputError("expected a JSON object");
  }
  return raw as Record<string, unknown>;
}

/** Scheme and host of an S3 endpoint. Anything past the host is refused: a
 *  path, query or embedded credentials would all change what gets signed. */
export function normalizeEndpoint(value: string, allowHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DestinationInputError("endpoint must be a URL such as https://s3.example.com");
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new DestinationInputError(
      allowHttp ? "endpoint must use http or https" : "endpoint must use https",
    );
  }
  if (url.username || url.password) throw new DestinationInputError("endpoint must not contain credentials");
  if ((url.pathname !== "" && url.pathname !== "/") || url.search || url.hash) {
    throw new DestinationInputError("endpoint must be a scheme and host only, without a path");
  }
  return url.origin;
}

export function validateAccessKeyId(value: string): string {
  if (value.length > 128 || /\s/.test(value) || CONTROL_CHARS.test(value)) {
    throw new DestinationInputError("accessKeyId is not a valid access key id");
  }
  return value;
}

export function validateSecretAccessKey(value: string): string {
  if (value.length > 256 || CONTROL_CHARS.test(value)) {
    throw new DestinationInputError("secretAccessKey is not a valid secret key");
  }
  return value;
}

export function parseS3Input(
  input: unknown,
  settings: AppConfig["backupDestinations"],
): { config: S3DestinationConfig; secretAccessKey: string; label: string } {
  const raw = asRecord(input);
  const endpoint = normalizeEndpoint(requiredStr(raw, "endpoint"), settings.s3AllowPrivateEndpoints);
  const region = (str(raw, "region") || "us-east-1").toLowerCase();
  if (!REGION_PATTERN.test(region)) throw new DestinationInputError("region is not a valid region name");
  const bucket = requiredStr(raw, "bucket");
  if (!BUCKET_PATTERN.test(bucket)) throw new DestinationInputError("bucket is not a valid bucket name");
  const forcePathStyle = bool(raw, "forcePathStyle", false);
  if (!forcePathStyle && !DNS_BUCKET_PATTERN.test(bucket)) {
    throw new DestinationInputError(
      "this bucket name cannot be used as a host name; turn on path-style addressing",
    );
  }
  const prefix = normalizeRelativePath(str(raw, "prefix") ?? "", "prefix", true);
  const storageClassRaw = str(raw, "storageClass");
  const storageClass = storageClassRaw ? storageClassRaw.toUpperCase() : null;
  if (storageClass && !STORAGE_CLASS_PATTERN.test(storageClass)) {
    throw new DestinationInputError("storageClass is not a valid storage class");
  }
  const accessKeyId = validateAccessKeyId(requiredStr(raw, "accessKeyId"));
  const secretAccessKey = validateSecretAccessKey(requiredStr(raw, "secretAccessKey"));
  const host = new URL(endpoint).host;
  return {
    config: { endpoint, region, bucket, prefix, forcePathStyle, accessKeyId, storageClass },
    secretAccessKey,
    label: label(raw, `${bucket}${prefix ? `/${prefix}` : ""} · ${host}`),
  };
}

export function parseRcloneInput(
  input: unknown,
  settings: AppConfig["backupDestinations"],
): { config: RcloneDestinationConfig; label: string } {
  const raw = asRecord(input);
  if (settings.rcloneRemotes.length === 0) {
    throw new DestinationInputError("rclone destinations are not enabled on this gateway");
  }
  const remote = requiredStr(raw, "remote");
  if (!settings.rcloneRemotes.includes(remote)) {
    throw new DestinationInputError(`"${remote}" is not one of the rclone remotes this gateway offers`);
  }
  const path = normalizeRelativePath(str(raw, "path") ?? "", "path", false);
  return { config: { remote, path }, label: label(raw, `${remote}:${path}`) };
}

/** Only the label may change on its own; see updateDestination. */
export function parseLabelUpdate(input: Record<string, unknown>, current: string): string {
  return label(input, current);
}

export function readS3Config(json: string): S3DestinationConfig {
  return JSON.parse(json) as S3DestinationConfig;
}

export function readRcloneConfig(json: string): RcloneDestinationConfig {
  return JSON.parse(json) as RcloneDestinationConfig;
}
