// S3 data-plane router (AGENTS.md §11-13). Path-style always works; virtual-
// hosted-style (`{bucket}.{S3_VIRTUAL_HOSTED_DOMAIN}`) is accepted only when
// the Host header matches the configured domain (see s3/key.ts). Authenticates
// with SigV4, resolves the owning user, and dispatches to bucket/object
// operations.

import type { AppContext } from "../context.ts";
import type { S3RequestContext } from "./context.ts";
import { driveErrorToS3Error, S3Error, s3ErrorResponse } from "./errors.ts";
import { DriveError } from "../drive/errors.ts";
import { SigV4Verifier, type SigV4Failure, type SigV4Result } from "../auth/s3-sigv4.ts";
import { SigV4PresignedVerifier } from "../auth/s3-sigv4-presigned.ts";
import { SigV4aVerifier } from "../auth/s3-sigv4a.ts";
import { resolveS3Path } from "./key.ts";
import * as buckets from "./operations/buckets.ts";
import * as objects from "./operations/objects.ts";
import * as multipart from "./operations/multipart.ts";
import { completeMultipartUpload } from "./operations/multipart-complete.ts";
import { copyObject } from "./operations/copy-object.ts";
import { postObject } from "./operations/post-object.ts";
import * as aclPolicy from "./operations/acl-policy.ts";
import { parseBoundary } from "./multipart-form.ts";
import { clientIpFrom, type HasRequestIp } from "../util/client-ip.ts";
import { retryAfterSeconds } from "../security/rate-limits.ts";

/**
 * A request that carried no credentials at all. It is "ok" in the sense that
 * there was nothing to reject — whether it may actually do anything is decided
 * later by AuthorizationService against the bucket's ACL and policy.
 */
interface AnonymousAuth {
  ok: true;
  userId: null;
  credentialId: null;
  streaming?: undefined;
}

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

/**
 * A PresignedPost is a multipart form POST at the bucket root. The `?delete`
 * bulk-delete route is also a bucket-root POST, so the query is checked too —
 * that one stays on the SigV4 path.
 */
function isPresignedPost(req: Request, url: URL): boolean {
  if (req.method !== "POST") return false;
  if (url.searchParams.has("delete") || url.searchParams.has("uploads")) return false;
  if (url.searchParams.has("uploadId")) return false;
  return parseBoundary(req.headers.get("content-type")) !== null;
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
    // PresignedPost authenticates from the signed policy inside the form body,
    // not from SigV4, so it has to branch before the verifiers run.
    if (isPresignedPost(req, url)) {
      const { bucket } = resolveS3Path(
        url.pathname,
        req.headers.get("host"),
        app.config.s3VirtualHostedDomain,
      );
      if (!bucket) throw new S3Error("MethodNotAllowed");
      const res = await postObject(app, req, bucket, requestId);
      res.headers.set("x-amz-request-id", requestId);
      return res;
    }

    const verifierInput = {
      method: req.method,
      pathname: url.pathname,
      query: url.searchParams,
      headers: req.headers,
    };
    // SigV4A first: it owns its own algorithm label in both the header and the
    // query form, and returns null for anything that is not SigV4A.
    let auth: SigV4Result | AnonymousAuth | null =
      new SigV4aVerifier(app.config, app.repos.credentials).verify(verifierInput) ??
      new SigV4PresignedVerifier(app.config, app.repos.credentials).verify(verifierInput);
    if (!auth) {
      if (url.searchParams.has("X-Amz-Signature")) {
        throw new S3Error("AuthorizationQueryParametersError");
      }
      // No signature of any kind. Rather than rejecting outright, fall through
      // as an anonymous principal so a public-read ACL or bucket policy can
      // admit the request — real S3 behaviour. Every operation still asks the
      // authorization layer, and anything requiring a caller refuses via
      // `requireUser`, so the default remains closed.
      const anonymousAllowed =
        app.config.s3AllowAnonymous && !req.headers.has("authorization");
      if (!anonymousAllowed) {
        auth = new SigV4Verifier(app.config, app.repos.credentials).verify(verifierInput);
      } else {
        // Anonymous traffic gets its own, tighter budget: it needs no
        // credential, so it is the cheapest surface to abuse.
        const anonDecision = app.rateLimits.take("s3Anonymous", ipKey);
        if (!anonDecision.allowed) {
          const throttled = new S3Error("SlowDown");
          const res = s3ErrorResponse(throttled, requestId);
          res.headers.set("Retry-After", retryAfterSeconds(anonDecision));
          return res;
        }
        auth = { ok: true, userId: null, credentialId: null };
      }
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

    const { bucket, key } = resolveS3Path(
      url.pathname,
      req.headers.get("host"),
      app.config.s3VirtualHostedDomain,
    );
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
      sourceIp: ipKey || null,
      secureTransport: url.protocol === "https:" ||
        (req.headers.get("x-forwarded-proto") ?? "").toLowerCase() === "https",
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
    if (q.has("acl")) {
      if (ctx.method === "GET") return aclPolicy.getBucketAcl(ctx, bucket);
      if (ctx.method === "PUT") return aclPolicy.putBucketAcl(ctx, bucket);
      throw new S3Error("MethodNotAllowed");
    }
    if (q.has("policyStatus")) {
      if (ctx.method === "GET") return aclPolicy.getBucketPolicyStatus(ctx, bucket);
      throw new S3Error("MethodNotAllowed");
    }
    if (q.has("policy")) {
      if (ctx.method === "GET") return aclPolicy.getBucketPolicy(ctx, bucket);
      if (ctx.method === "PUT") return aclPolicy.putBucketPolicy(ctx, bucket);
      if (ctx.method === "DELETE") return aclPolicy.deleteBucketPolicy(ctx, bucket);
      throw new S3Error("MethodNotAllowed");
    }
    if (q.has("encryption")) {
      if (ctx.method === "GET") return aclPolicy.getBucketEncryption(ctx, bucket);
      if (ctx.method === "PUT") return aclPolicy.putBucketEncryption(ctx, bucket);
      if (ctx.method === "DELETE") return aclPolicy.deleteBucketEncryption(ctx, bucket);
      throw new S3Error("MethodNotAllowed");
    }
    if (q.has("location")) {
      if (ctx.method === "GET") return aclPolicy.getBucketLocation(ctx, bucket);
      throw new S3Error("MethodNotAllowed");
    }
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

  if (q.has("acl")) {
    if (ctx.method === "GET") return aclPolicy.getObjectAcl(ctx, bucket, key);
    if (ctx.method === "PUT") return aclPolicy.putObjectAcl(ctx, bucket, key);
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
