// Google OAuth web-server flow + ID token verification (AGENTS.md §7).
// We call Google REST endpoints directly with fetch. The `hd` claim in the
// verified ID token is the security control for domain restriction — never
// the request parameter.

import { createHash, randomBytes } from "node:crypto";
import type { AppConfig } from "../config.ts";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CERTS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";
const VALID_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export const IDENTITY_SCOPES = ["openid", "email", "profile"] as const;

function requiredDriveScopes(config: AppConfig): string[] {
  return config.google.driveScope
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

export function requiredScopes(config: AppConfig): string[] {
  return [...new Set([...IDENTITY_SCOPES, ...requiredDriveScopes(config)])];
}

export function hasRequiredScopes(config: AppConfig, grantedScopes: string): boolean {
  const granted = new Set(grantedScopes.split(/\s+/).filter(Boolean));
  // Google's token response may canonicalize the identity aliases `email` and
  // `profile` to userinfo URLs. ID-token verification already proves the
  // identity grant, so reconnect eligibility only needs the configured Drive
  // scopes to avoid an endless reauthorization loop.
  return requiredDriveScopes(config).every((scope) => granted.has(scope));
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function generateState(): string {
  return randomBytes(24).toString("base64url");
}

export interface StartUrlInput {
  state: string;
  pkceChallenge: string;
  promptConsent: boolean;
}

export function buildAuthUrl(config: AppConfig, input: StartUrlInput): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.google.clientId,
    redirect_uri: config.google.redirectUri,
    scope: requiredScopes(config).join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    state: input.state,
    code_challenge: input.pkceChallenge,
    code_challenge_method: "S256",
  });
  // UX hint only; omitted when the app also accepts non-Workspace accounts
  // via ALLOWED_EMAILS, since Google rejects a blank `hd` param.
  if (config.google.workspaceDomain !== "") {
    params.set("hd", config.google.workspaceDomain);
  }
  if (input.promptConsent) params.set("prompt", "consent");
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
  id_token: string;
}

export async function exchangeCode(
  config: AppConfig,
  code: string,
  pkceVerifier: string,
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    redirect_uri: config.google.redirectUri,
    grant_type: "authorization_code",
    code_verifier: pkceVerifier,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal,
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status}`);
  }
  return (await res.json()) as TokenResponse;
}

export interface RefreshResponse {
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
  id_token?: string;
}

export async function refreshAccessToken(
  config: AppConfig,
  refreshToken: string,
  signal?: AbortSignal,
): Promise<RefreshResponse> {
  const body = new URLSearchParams({
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    // invalid_grant means the refresh token was revoked.
    const revoked = res.status === 400 && text.includes("invalid_grant");
    const err = new Error(`token refresh failed: ${res.status}`);
    (err as Error & { revoked?: boolean }).revoked = revoked;
    throw err;
  }
  return (await res.json()) as RefreshResponse;
}

export interface IdTokenClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  hd?: string;
  name?: string;
  iss: string;
  aud: string;
  exp: number;
}

interface Jwk {
  kid: string;
  n: string;
  e: string;
  alg?: string;
  kty: string;
}

let certsCache: { keys: Jwk[]; fetchedAt: number } | null = null;
const CERTS_TTL_MS = 60 * 60 * 1000;

async function fetchCerts(signal?: AbortSignal): Promise<Jwk[]> {
  if (certsCache && Date.now() - certsCache.fetchedAt < CERTS_TTL_MS) {
    return certsCache.keys;
  }
  const res = await fetch(CERTS_ENDPOINT, { signal });
  if (!res.ok) throw new Error(`failed to fetch google certs: ${res.status}`);
  const data = (await res.json()) as { keys: Jwk[] };
  certsCache = { keys: data.keys, fetchedAt: Date.now() };
  return data.keys;
}

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

async function verifyRs256(
  header: { kid?: string; alg?: string },
  signingInput: string,
  signature: Buffer,
  keys: Jwk[],
): Promise<boolean> {
  if (header.alg !== "RS256") return false;
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return false;
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    signature,
    new TextEncoder().encode(signingInput),
  );
}

/**
 * Verify a Google ID token: signature, issuer, audience, expiry, verified
 * email, and that the account is allowed in — either its `hd` claim matches
 * the configured Workspace domain, or its email is in ALLOWED_EMAILS.
 */
export async function verifyIdToken(
  config: AppConfig,
  idToken: string,
  signal?: AbortSignal,
): Promise<IdTokenClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed id token");
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  const header = JSON.parse(b64urlToBuf(headerB64).toString("utf8")) as {
    kid?: string;
    alg?: string;
  };
  const claims = JSON.parse(b64urlToBuf(payloadB64).toString("utf8")) as IdTokenClaims;

  const keys = await fetchCerts(signal);
  const ok = await verifyRs256(header, `${headerB64}.${payloadB64}`, b64urlToBuf(sigB64), keys);
  if (!ok) throw new Error("id token signature invalid");

  if (!VALID_ISSUERS.has(claims.iss)) throw new Error("id token issuer invalid");
  if (claims.aud !== config.google.clientId) throw new Error("id token audience mismatch");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) {
    throw new Error("id token expired");
  }
  if (!claims.email_verified) throw new Error("email not verified");

  const domainAllowed =
    config.google.workspaceDomain !== "" && claims.hd === config.google.workspaceDomain;
  const emailAllowed = config.google.allowedEmails.includes(claims.email.toLowerCase());
  if (!domainAllowed && !emailAllowed) {
    throw new Error("account not allowed");
  }
  return claims;
}
