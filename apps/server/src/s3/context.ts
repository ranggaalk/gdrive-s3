// S3 request context passed to every operation. Constructed by the router
// after authentication — or, for a request that carried no credentials at all,
// with a null userId so the authorization layer can decide whether an ACL or
// bucket policy admits the anonymous public.

import type { AppContext } from "../context.ts";
import { S3Error } from "./errors.ts";

export interface S3RequestContext {
  app: AppContext;
  /** Null for an anonymous request. Use `requireUser` where a caller is
   *  mandatory, and `driveActor` to pick whose Drive token moves the bytes. */
  userId: string | null;
  credentialId: string | null;
  requestId: string;
  method: string;
  url: URL;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  streamingAuth?: {
    signingKey: Buffer;
    seedSignature: string;
    amzDate: string;
    scope: string;
  };
  signal: AbortSignal | null;
  /** Client IP, for policy conditions on aws:SourceIp. */
  sourceIp: string | null;
  /** Whether the request reached us over TLS, for aws:SecureTransport. */
  secureTransport: boolean;
}

/**
 * Assert an authenticated caller. Operations that can never be anonymous —
 * ListBuckets, CreateBucket, the multipart lifecycle — start with this so an
 * unauthenticated request is refused before it can touch anything.
 */
export function requireUser(ctx: S3RequestContext): string {
  if (ctx.userId === null) throw new S3Error("AccessDenied");
  return ctx.userId;
}

/**
 * Whose Google Drive credentials should move the bytes.
 *
 * Authorization and storage identity are separate concerns: an anonymous
 * caller may be *authorized* by a public-read ACL, but the bytes still live in
 * the bucket owner's Drive and only the owner's token can fetch them. Any
 * authenticated caller acts as themselves, as before.
 */
export function driveActor(
  ctx: S3RequestContext,
  bucket: { user_id: string },
): string {
  return ctx.userId ?? bucket.user_id;
}
