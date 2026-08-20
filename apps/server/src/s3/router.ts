// S3 data-plane router (AGENTS.md §11-13). Path-style only. Authenticates with
// SigV4, resolves the owning user, and dispatches to bucket/object operations.

import type { AppContext } from "../context.ts";
import type { S3RequestContext } from "./context.ts";
import { driveErrorToS3Error, S3Error, s3ErrorResponse } from "./errors.ts";
import { DriveError } from "../drive/errors.ts";
import { SigV4Verifier, type SigV4Failure } from "../auth/s3-sigv4.ts";
import { SigV4PresignedVerifier } from "../auth/s3-sigv4-presigned.ts";
import { decodeS3Path } from "./key.ts";
import * as buckets from "./operations/buckets.ts";
import * as objects from "./operations/objects.ts";
import * as multipart from "./operations/multipart.ts";
import { completeMultipartUpload } from "./operations/multipart-complete.ts";
import { copyObject } from "./operations/copy-object.ts";
import { clientIpFrom, type HasRequestIp } from "../util/client-ip.ts";
import { retryAfterSeconds } from "../security/rate-limits.ts";

function failureToError(failure: SigV4Failure): S3Error {
  switch (failure) {
    case "InvalidAccessKeyId":
      return new S3Error("InvalidAccessKeyId");
    case "RequestTimeTooSkewed":
      return new S3Error("RequestTimeTooSkewed");
    case "MissingAuthorization":
    case "MalformedAuthorization":
    case "CredentialScopeMismatch":
    case "UnsignedNotAllowed":
      return new S3Error("AccessDenied");
    case "SignatureDoesNotMatch":
    default:
      return new S3Error("SignatureDoesNotMatch");
  }
}

export async function handleS3(
  app: AppContext,
  req: Request,
  requestId: string,
  server: HasRequestIp | null = null,
): Promise<Response> {
  const url = new URL(req.url);
  const ipKey = clientIpFrom(req, server, app.config);
  const publicDecision = app.rateLimits.take("s3Public", ipKey);
  if (!publicDecision.allowed) {
    const throttled = new S3Error("SlowDown");
    const res = s3ErrorResponse(throttled, requestId);
    res.headers.set("Retry-After", retryAfterSeconds(publicDecision));
    return res;
  }
  try {
    const presigned = new SigV4PresignedVerifier(app.config, app.repos.credentials).verify({
      method: req.method,
      pathname: url.pathname,
      query: url.searchParams,
      headers: req.headers,
    });
    let auth = presigned;
    if (!auth) {
      if (url.searchParams.has("X-Amz-Signature")) {
        throw new S3Error("AuthorizationQueryParametersError");
      }
      auth = new SigV4Verifier(app.config, app.repos.credentials).verify({
        method: req.method,
        pathname: url.pathname,
        query: url.searchParams,
        headers: req.headers,
      });
    }
    if (!auth.ok) {
      const failureDecision = app.rateLimits.take("signatureFailure", ipKey);
      if (!failureDecision.allowed) {
        const throttled = new S3Error("SlowDown");
        const res = s3ErrorResponse(throttled, requestId);
        res.headers.set("Retry-After", retryAfterSeconds(failureDecision));
        return res;
      }
      throw failureToError(auth.failure);
    }

    const { bucket, key } = decodeS3Path(url.pathname);
    const ctx: S3RequestContext = {
      app,
      userId: auth.userId,
      credentialId: auth.credentialId,
      requestId,
      method: req.method,
      url,
      headers: req.headers,
      body: req.body,
      ...(auth.streaming ? { streamingAuth: auth.streaming } : {}),
      signal: req.signal,
    };

    try {
      const res = await dispatch(ctx, bucket, key);
      res.headers.set("x-amz-request-id", requestId);
      return res;
    } finally {
      auth.streaming?.signingKey.fill(0);
    }
  } catch (err) {
    if (err instanceof S3Error) return s3ErrorResponse(err, requestId);
    if (err instanceof DriveError) {
      app.log.warn("s3 drive error", {
        requestId,
        route: url.pathname,
        category: err.category,
        status: err.status,
      });
      return s3ErrorResponse(driveErrorToS3Error(err), requestId);
    }
    app.log.error("s3 unhandled error", {
      requestId,
      route: url.pathname,
      error: err instanceof Error ? err.message : String(err),
    });
    return s3ErrorResponse(new S3Error("InternalError"), requestId);
  }
}

async function dispatch(
  ctx: S3RequestContext,
  bucket: string | null,
  key: string | null,
): Promise<Response> {
  const q = ctx.url.searchParams;

  // Service root: GET / => ListBuckets
  if (bucket === null) {
    if (ctx.method === "GET") return buckets.listBuckets(ctx);
    throw new S3Error("MethodNotAllowed");
  }

  // Bucket-level (no key or empty key)
  if (key === null || key === "") {
    if (ctx.method === "GET" && q.has("uploads")) {
      return multipart.listMultipartUploads(ctx, bucket);
    }
    if (ctx.method === "GET") {
      const listType = q.get("list-type");
      if (listType === null) return buckets.listObjectsV1(ctx, bucket);
      if (listType === "2") return buckets.listObjectsV2(ctx, bucket);
      throw new S3Error("InvalidArgument", { ArgumentName: "list-type" });
    }
    if (ctx.method === "PUT") return buckets.createBucket(ctx, bucket);
    if (ctx.method === "HEAD") return buckets.headBucket(ctx, bucket);
    if (ctx.method === "POST" && q.has("delete")) return objects.deleteObjects(ctx, bucket);
    if (ctx.method === "DELETE") return buckets.deleteBucket(ctx, bucket);
    throw new S3Error("MethodNotAllowed");
  }

  // Object-level multipart lifecycle.
  if (ctx.method === "POST" && q.has("uploads")) {
    return multipart.createMultipartUpload(ctx, bucket, key);
  }
  if (q.has("uploadId")) {
    if (ctx.method === "PUT" && q.has("partNumber")) {
      return multipart.uploadPart(ctx, bucket, key);
    }
    if (ctx.method === "GET") return multipart.listParts(ctx, bucket, key);
    if (ctx.method === "POST") return completeMultipartUpload(ctx, bucket, key);
    if (ctx.method === "DELETE") return multipart.abortMultipartUpload(ctx, bucket, key);
    throw new S3Error("MethodNotAllowed");
  }
  if (ctx.method === "PUT" && ctx.headers.has("x-amz-copy-source")) {
    return copyObject(ctx, bucket, key);
  }
  if (ctx.method === "PUT") return objects.putObject(ctx, bucket, key);
  if (ctx.method === "GET") return objects.getObject(ctx, bucket, key);
  if (ctx.method === "HEAD") return objects.headObject(ctx, bucket, key);
  if (ctx.method === "DELETE") return objects.deleteObject(ctx, bucket, key);
  throw new S3Error("MethodNotAllowed");
}
