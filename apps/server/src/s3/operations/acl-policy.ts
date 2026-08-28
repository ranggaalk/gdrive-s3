// The ?acl, ?policy, and ?policyStatus sub-resources.
//
// Reading or writing a bucket's own access configuration is owner-only, and
// deliberately so: a policy that could grant s3:PutBucketPolicy would be able
// to rewrite itself, which turns one mistaken statement into a permanent loss
// of control over the bucket.

import { requireUser, type S3RequestContext } from "../context.ts";
import { authorizeBucket } from "../authorize.ts";
import { S3Error } from "../errors.ts";
import { accessControlPolicyXml, cannedAclFromXml, isBucketAcl, isObjectAcl } from "../acl.ts";
import { parseBucketPolicy, policyIsPublic } from "../policy.ts";
import { tag, xmlDocument, xmlResponse } from "../xml.ts";
import { BodyTooLargeError, readBoundedText } from "../../util/body-size.ts";
import type { BucketAclName } from "../../db/repositories/buckets.ts";
import type { ObjectAclName } from "../../db/repositories/objects.ts";

async function readBody(ctx: S3RequestContext): Promise<string> {
  try {
    return await readBoundedText(ctx.body, ctx.app.config.maxS3XmlBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new S3Error("EntityTooLarge");
    throw error;
  }
}

function ownerLabel(ctx: S3RequestContext, ownerUserId: string): { id: string; name: string } {
  const user = ctx.app.repos.users.findById(ownerUserId);
  return { id: ownerUserId, name: user?.email ?? "" };
}

export async function getBucketAcl(
  ctx: S3RequestContext,
  bucketName: string,
): Promise<Response> {
  const { bucket } = authorizeBucket(ctx, bucketName, "s3:GetBucketAcl");
  const owner = ownerLabel(ctx, bucket.user_id);
  const body = accessControlPolicyXml({
    acl: bucket.acl,
    ownerId: owner.id,
    ownerName: owner.name,
  });
  return xmlResponse(body, 200, { "x-amz-request-id": ctx.requestId });
}

export async function putBucketAcl(
  ctx: S3RequestContext,
  bucketName: string,
): Promise<Response> {
  requireUser(ctx);
  const { bucket } = authorizeBucket(ctx, bucketName, "s3:PutBucketAcl");

  // The header form wins when present, matching S3; otherwise the body is an
  // AccessControlPolicy document.
  const header = ctx.headers.get("x-amz-acl");
  let acl: BucketAclName;
  if (header !== null) {
    if (!isBucketAcl(header)) throw new S3Error("InvalidArgument", { ArgumentName: "x-amz-acl" });
    acl = header;
  } else {
    acl = cannedAclFromXml(await readBody(ctx));
  }

  ctx.app.repos.buckets.setAcl(bucket.id, acl);
  ctx.app.repos.audit.record({
    userId: ctx.userId,
    credentialId: ctx.credentialId,
    action: "s3.PutBucketAcl",
    bucketName,
    bucketId: bucket.id,
    statusCode: 200,
    requestId: ctx.requestId,
    detail: { acl },
  });
  return new Response(null, { status: 200, headers: { "x-amz-request-id": ctx.requestId } });
}

export async function getObjectAcl(
  ctx: S3RequestContext,
  bucketName: string,
  key: string,
): Promise<Response> {
  const { bucket, object } = authorizeBucket(ctx, bucketName, "s3:GetObjectAcl", key);
  if (!object) throw new S3Error("NoSuchKey", { Key: key });
  const owner = ownerLabel(ctx, bucket.user_id);
  const body = accessControlPolicyXml({
    acl: object.acl,
    ownerId: owner.id,
    ownerName: owner.name,
  });
  return xmlResponse(body, 200, { "x-amz-request-id": ctx.requestId });
}

export async function putObjectAcl(
  ctx: S3RequestContext,
  bucketName: string,
  key: string,
): Promise<Response> {
  requireUser(ctx);
  const { bucket, object } = authorizeBucket(ctx, bucketName, "s3:PutObjectAcl", key);
  if (!object) throw new S3Error("NoSuchKey", { Key: key });

  const header = ctx.headers.get("x-amz-acl");
  let acl: ObjectAclName;
  if (header !== null) {
    if (!isObjectAcl(header)) throw new S3Error("InvalidArgument", { ArgumentName: "x-amz-acl" });
    acl = header;
  } else {
    acl = cannedAclFromXml(await readBody(ctx));
  }

  ctx.app.repos.objects.setAcl(bucket.id, key, acl);
  ctx.app.repos.audit.record({
    userId: ctx.userId,
    credentialId: ctx.credentialId,
    action: "s3.PutObjectAcl",
    bucketName,
    bucketId: bucket.id,
    objectKey: key,
    statusCode: 200,
    requestId: ctx.requestId,
    detail: { acl },
  });
  return new Response(null, { status: 200, headers: { "x-amz-request-id": ctx.requestId } });
}

export async function getBucketPolicy(
  ctx: S3RequestContext,
  bucketName: string,
): Promise<Response> {
  requireUser(ctx);
  const { bucket } = authorizeBucket(ctx, bucketName, "s3:GetBucketPolicy");
  const row = ctx.app.repos.bucketPolicies.find(bucket.id);
  if (!row) throw new S3Error("NoSuchBucketPolicy", { BucketName: bucketName });
  // S3 returns the policy as JSON, not XML.
  return new Response(row.policy_json, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "x-amz-request-id": ctx.requestId,
    },
  });
}

export async function putBucketPolicy(
  ctx: S3RequestContext,
  bucketName: string,
): Promise<Response> {
  const userId = requireUser(ctx);
  const { bucket } = authorizeBucket(ctx, bucketName, "s3:PutBucketPolicy");
  const raw = await readBody(ctx);

  // Parse before storing: a document that cannot be evaluated would silently
  // behave as "no policy", so it must be rejected at the door rather than
  // discovered later when it fails to protect anything.
  const parsed = parseBucketPolicy(raw);

  ctx.app.repos.bucketPolicies.put({
    bucketId: bucket.id,
    policyJson: raw,
    updatedBy: userId,
  });
  ctx.app.repos.audit.record({
    userId,
    credentialId: ctx.credentialId,
    action: "s3.PutBucketPolicy",
    bucketName,
    bucketId: bucket.id,
    statusCode: 204,
    requestId: ctx.requestId,
    detail: { statements: parsed.statements.length, public: policyIsPublic(parsed) },
  });
  return new Response(null, { status: 204, headers: { "x-amz-request-id": ctx.requestId } });
}

export async function deleteBucketPolicy(
  ctx: S3RequestContext,
  bucketName: string,
): Promise<Response> {
  const userId = requireUser(ctx);
  const { bucket } = authorizeBucket(ctx, bucketName, "s3:PutBucketPolicy");
  const removed = ctx.app.repos.bucketPolicies.delete(bucket.id);
  if (!removed) throw new S3Error("NoSuchBucketPolicy", { BucketName: bucketName });
  ctx.app.repos.audit.record({
    userId,
    credentialId: ctx.credentialId,
    action: "s3.DeleteBucketPolicy",
    bucketName,
    bucketId: bucket.id,
    statusCode: 204,
    requestId: ctx.requestId,
  });
  return new Response(null, { status: 204, headers: { "x-amz-request-id": ctx.requestId } });
}

export async function getBucketPolicyStatus(
  ctx: S3RequestContext,
  bucketName: string,
): Promise<Response> {
  requireUser(ctx);
  const { bucket } = authorizeBucket(ctx, bucketName, "s3:GetBucketPolicy");
  const isPublic = ctx.app.authorization.isPublic(bucket);
  const body = xmlDocument(
    "PolicyStatus",
    tag("IsPublic", isPublic ? "true" : "false"),
  );
  return xmlResponse(body, 200, { "x-amz-request-id": ctx.requestId });
}

/** GetBucketLocation — every bucket reports the gateway's configured region. */
export async function getBucketLocation(
  ctx: S3RequestContext,
  bucketName: string,
): Promise<Response> {
  authorizeBucket(ctx, bucketName, "s3:GetBucketLocation");
  const body = xmlDocument(
    "LocationConstraint",
    ctx.app.config.s3Region === "us-east-1" ? "" : ctx.app.config.s3Region,
  );
  return xmlResponse(body, 200, { "x-amz-request-id": ctx.requestId });
}
