// PresignedPost: browser form uploads via POST /{bucket}.
//
// This is the one data-plane route that does not authenticate with SigV4. The
// browser never sees the secret key; instead a trusted party signs a policy
// document, and the form carries that policy plus its signature. So the
// authorization decision lives entirely in the policy, which is why every
// condition is enforced and every submitted field must be covered by one.
//
// The handler takes the raw request rather than an S3RequestContext, because
// the acting user is only known after the policy verifies.

import type { AppContext } from "../../context.ts";
import { S3Error } from "../errors.ts";
import { quoteEtag } from "../etag.ts";
import { validateObjectKey } from "../key.ts";
import { parseMultipartForm } from "../multipart-form.ts";
import { tag, xmlDocument, xmlResponse } from "../xml.ts";
import {
  POST_ALGORITHM,
  checkPostPolicy,
  contentLengthRange,
  parsePostCredential,
  parsePostPolicy,
  PostPolicyError,
  verifyPostSignature,
} from "../../auth/s3-post-policy.ts";
import { aad, openFromString } from "../../security/encryption.ts";
import {
  ObjectAccessError,
  ObjectService,
} from "../../services/object-service.ts";
import type { ObjectMetadataHeaders } from "../metadata.ts";

/** Enough for the policy plus the handful of fields around it, and small
 *  enough that a form cannot be used to buffer arbitrary data. */
const MAX_FORM_FIELD_BYTES = 64 * 1024;
const MAX_FORM_FIELDS = 40;

const MAX_SKEW_MS = 15 * 60 * 1000;

function parseAmzDate(value: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}

/** S3 substitutes the uploaded file's name wherever ${filename} appears. */
function resolveKey(template: string, filename: string | null): string {
  if (!template.includes("${filename}")) return template;
  // A filename is a single path segment; anything else is a traversal attempt.
  const safe = (filename ?? "").split(/[/\\]/).pop() ?? "";
  return template.replaceAll("${filename}", safe);
}

function metadataFromFields(
  fields: Map<string, string>,
  fallbackContentType: string | null,
): ObjectMetadataHeaders {
  const userMetadata: Record<string, string> = {};
  for (const [name, value] of fields) {
    if (!name.startsWith("x-amz-meta-")) continue;
    const key = name.slice("x-amz-meta-".length);
    if (key) userMetadata[key] = value;
  }
  return {
    contentType:
      fields.get("content-type") ?? fallbackContentType ?? "application/octet-stream",
    cacheControl: fields.get("cache-control") ?? null,
    contentDisposition: fields.get("content-disposition") ?? null,
    contentEncoding: fields.get("content-encoding") ?? null,
    contentLanguage: fields.get("content-language") ?? null,
    expiresAt: null,
    userMetadata,
  };
}

export async function postObject(
  app: AppContext,
  req: Request,
  bucketName: string,
  requestId: string,
): Promise<Response> {
  if (!req.body) throw new S3Error("InvalidRequest", { Reason: "Missing request body." });

  const form = await parseMultipartForm({
    body: req.body,
    contentType: req.headers.get("content-type"),
    maxFieldBytes: MAX_FORM_FIELD_BYTES,
    maxFieldCount: MAX_FORM_FIELDS,
  });

  const fields = form.fields;
  const policyBase64 = fields.get("policy");
  const signature = fields.get("x-amz-signature");
  const credentialRaw = fields.get("x-amz-credential");
  const algorithm = fields.get("x-amz-algorithm");
  const amzDate = fields.get("x-amz-date");
  const keyTemplate = fields.get("key");

  // Cancel the file stream on any rejection so the connection is not left
  // half-read waiting for bytes nobody will consume.
  const reject = async (error: S3Error): Promise<never> => {
    await form.file?.stream.cancel().catch(() => {});
    throw error;
  };

  if (!policyBase64 || !signature || !credentialRaw || !keyTemplate) {
    return reject(new S3Error("AccessDenied"));
  }
  if (algorithm !== POST_ALGORITHM) {
    return reject(new S3Error("InvalidArgument", { ArgumentName: "x-amz-algorithm" }));
  }
  if (!form.file) {
    return reject(new S3Error("InvalidRequest", { Reason: "Form is missing the file field." }));
  }

  const credential = parsePostCredential(credentialRaw);
  if (!credential) return reject(new S3Error("AccessDenied"));
  if (credential.region !== app.config.s3Region || credential.service !== "s3") {
    return reject(new S3Error("AccessDenied"));
  }
  if (amzDate !== undefined) {
    const ts = parseAmzDate(amzDate);
    if (ts === null) return reject(new S3Error("AccessDenied"));
    if (Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
      return reject(new S3Error("RequestTimeTooSkewed"));
    }
    if (credential.dateStamp !== amzDate.slice(0, 8)) {
      return reject(new S3Error("AccessDenied"));
    }
  }

  const cred = app.repos.credentials.findActiveByAccessKeyId(credential.accessKeyId);
  if (!cred) return reject(new S3Error("InvalidAccessKeyId"));

  let secret: string;
  try {
    secret = openFromString(
      cred.encrypted_secret_key,
      app.config.masterEncryptionKey,
      aad.s3Secret(cred.id),
    );
  } catch {
    return reject(new S3Error("AccessDenied"));
  }
  let signatureOk: boolean;
  try {
    signatureOk = verifyPostSignature({
      secretAccessKey: secret,
      credential,
      policyBase64,
      signature,
    });
  } finally {
    secret = "";
    void secret;
  }
  if (!signatureOk) return reject(new S3Error("SignatureDoesNotMatch"));

  let policy;
  try {
    policy = parsePostPolicy(policyBase64);
  } catch (error) {
    if (error instanceof PostPolicyError) {
      return reject(new S3Error("InvalidRequest", { Reason: error.message }));
    }
    return reject(new S3Error("AccessDenied"));
  }

  const key = resolveKey(keyTemplate, form.file.filename);
  if (!key) return reject(new S3Error("InvalidRequest", { Reason: "Resolved key is empty." }));

  // `bucket` and the resolved `key` are what conditions actually constrain, so
  // they are evaluated even though only `key` was submitted as a field.
  const evaluated = new Map(fields);
  evaluated.set("bucket", bucketName);
  evaluated.set("key", key);

  const violation = checkPostPolicy({
    policy,
    fields: evaluated,
    submittedFields: fields.keys(),
  });
  if (violation) return reject(new S3Error("AccessDenied", { Reason: violation }));

  try {
    validateObjectKey(key, true);
  } catch (error) {
    await form.file.stream.cancel().catch(() => {});
    throw error;
  }

  let bucket;
  try {
    bucket = app.bucketAccess.findByName(cred.user_id, bucketName, "write");
  } catch {
    return reject(new S3Error("AccessDenied"));
  }
  if (!bucket) return reject(new S3Error("NoSuchBucket", { BucketName: bucketName }));

  const range = contentLengthRange(policy);
  const metadata = metadataFromFields(fields, form.file.contentType);

  let uploaded;
  try {
    uploaded = await new ObjectService(app).upload({
      actorUserId: cred.user_id,
      bucket,
      key,
      requestId: `${requestId}:post:${crypto.randomUUID()}`,
      body: form.file.stream,
      contentLength: null,
      metadata,
      maxBytes: range?.max,
      signal: req.signal,
      verify: (result) => {
        if (range && (result.size < range.min || result.size > range.max)) {
          throw new S3Error("EntityTooLarge", {
            Reason: "Upload size is outside the policy's content-length-range.",
          });
        }
      },
    });
  } catch (error) {
    if (error instanceof ObjectAccessError) throw new S3Error("AccessDenied");
    throw error;
  }

  const object = uploaded.current;
  const etag = quoteEtag(object.etag);
  const location = `${app.config.s3PublicEndpoint.replace(/\/$/, "")}/${bucketName}/${key}`;

  app.repos.audit.record({
    userId: cred.user_id,
    credentialId: cred.id,
    action: "s3.PostObject",
    bucketName,
    bucketId: bucket.id,
    objectKey: key,
    statusCode: 204,
    bytesIn: uploaded.result.size,
    requestId,
  });

  const redirect = fields.get("success_action_redirect") ?? fields.get("redirect");
  if (redirect) {
    const target = safeRedirect(redirect, bucketName, key, object.etag);
    if (target) {
      return new Response(null, {
        status: 303,
        headers: { Location: target, ETag: etag, "x-amz-request-id": requestId },
      });
    }
  }

  const status = fields.get("success_action_status");
  if (status === "200") {
    return new Response(null, {
      status: 200,
      headers: { ETag: etag, "x-amz-request-id": requestId },
    });
  }
  if (status === "201") {
    const body = xmlDocument(
      "PostResponse",
      tag("Location", location) +
        tag("Bucket", bucketName) +
        tag("Key", key) +
        tag("ETag", etag),
    );
    return xmlResponse(body, 201, { ETag: etag, "x-amz-request-id": requestId });
  }

  // S3 defaults to 204 when success_action_status is absent or unrecognised.
  return new Response(null, {
    status: 204,
    headers: { ETag: etag, Location: location, "x-amz-request-id": requestId },
  });
}

/**
 * Only http(s) redirects are honoured, and the S3 result parameters are
 * appended. A form field must never be able to produce a `javascript:` or
 * `data:` Location.
 */
function safeRedirect(
  raw: string,
  bucketName: string,
  key: string,
  etag: string,
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.searchParams.set("bucket", bucketName);
  url.searchParams.set("key", key);
  url.searchParams.set("etag", quoteEtag(etag));
  return url.toString();
}
