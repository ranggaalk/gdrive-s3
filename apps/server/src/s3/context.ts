// S3 request context passed to every operation. Constructed by the router
// after successful SigV4 verification.

import type { AppContext } from "../context.ts";

export interface S3RequestContext {
  app: AppContext;
  userId: string;
  credentialId: string;
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
}
