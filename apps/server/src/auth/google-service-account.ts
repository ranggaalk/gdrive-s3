// Service-account credentials for the quota probe. This is a second, read-only
// identity, separate from the user OAuth flow in google-oauth.ts: it reads the
// Google Cloud project's own quota figures, which no end-user token can see.
// The private key stays in memory and is never logged or persisted.

import { createSign } from "node:crypto";
import type { FetchLike } from "../util/fetch-like.ts";

export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
  projectId: string | null;
  tokenUri: string;
}

export class ServiceAccountError extends Error {}

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/**
 * Enough for Service Usage and Cloud Monitoring reads, and nothing else.
 *
 * Two scopes are required, not one. Cloud Monitoring rejects
 * cloud-platform.read-only outright (ACCESS_TOKEN_SCOPE_INSUFFICIENT) and wants
 * monitoring.read, while Service Usage does not accept monitoring.read. Both
 * are read-only, so this is still the minimum that works.
 */
export const QUOTA_PROBE_SCOPE = [
  "https://www.googleapis.com/auth/monitoring.read",
  "https://www.googleapis.com/auth/cloud-platform.read-only",
].join(" ");

/**
 * Parse a service-account key file. Accepts the raw JSON Google hands out, or
 * the same JSON base64-encoded so it survives a single-line env var.
 */
export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  const text = raw.trim();
  if (text === "") throw new ServiceAccountError("service account key is empty");

  const json = text.startsWith("{") ? text : decodeBase64Json(text);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new ServiceAccountError("service account key is not valid JSON");
  }

  if (parsed.type !== undefined && parsed.type !== "service_account") {
    throw new ServiceAccountError(`expected a service_account key, got type=${String(parsed.type)}`);
  }
  const clientEmail = stringField(parsed, "client_email");
  // Env vars and JSON-in-JSON both tend to arrive with escaped newlines.
  const privateKey = stringField(parsed, "private_key").replace(/\\n/g, "\n");
  if (!privateKey.includes("BEGIN") || !privateKey.includes("PRIVATE KEY")) {
    throw new ServiceAccountError("service account private_key is not a PEM private key");
  }

  return {
    clientEmail,
    privateKey,
    projectId: typeof parsed.project_id === "string" && parsed.project_id !== ""
      ? parsed.project_id
      : null,
    tokenUri: typeof parsed.token_uri === "string" && parsed.token_uri !== ""
      ? parsed.token_uri
      : DEFAULT_TOKEN_URI,
  };
}

function decodeBase64Json(value: string): string {
  const decoded = Buffer.from(value, "base64").toString("utf8");
  if (!decoded.trimStart().startsWith("{")) {
    throw new ServiceAccountError("service account key must be JSON or base64-encoded JSON");
  }
  return decoded;
}

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ServiceAccountError(`service account key is missing ${key}`);
  }
  return value;
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** Build the self-signed assertion Google exchanges for an access token. */
export function buildAssertion(
  key: ServiceAccountKey,
  scope: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  lifetimeSeconds = 3600,
): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: key.clientEmail,
      scope,
      aud: key.tokenUri,
      iat: nowSeconds,
      exp: nowSeconds + lifetimeSeconds,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(key.privateKey);
  return `${signingInput}.${base64Url(signature)}`;
}

export interface ServiceAccountToken {
  accessToken: string;
  expiresAtMs: number;
}

/** Exchange an assertion for an access token. Caching is the caller's job. */
export async function fetchServiceAccountToken(
  key: ServiceAccountKey,
  scope: string = QUOTA_PROBE_SCOPE,
  fetcher: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<ServiceAccountToken> {
  const res = await fetcher(key.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: JWT_BEARER_GRANT,
      assertion: buildAssertion(key, scope),
    }),
    signal,
  });

  if (!res.ok) {
    // Google echoes the assertion's subject but never the key itself; the
    // body is still an error document, so keep it short.
    const text = (await res.text()).slice(0, 300);
    throw new ServiceAccountError(`token exchange failed (${res.status}): ${text}`);
  }

  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new ServiceAccountError("token exchange returned no access_token");
  return {
    accessToken: body.access_token,
    expiresAtMs: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
}
