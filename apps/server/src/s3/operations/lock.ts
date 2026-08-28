// The ?object-lock, ?retention, and ?legal-hold sub-resources.

import { requireUser, type S3RequestContext } from "../context.ts";
import { authorizeBucket } from "../authorize.ts";
import { S3Error } from "../errors.ts";
import { tag, xmlDocument, xmlResponse } from "../xml.ts";
import { BodyTooLargeError, readBoundedText } from "../../util/body-size.ts";
import {
  bypassRequested,
  canReplaceRetention,
  isLockMode,
  parseLegalHoldXml,
  parseRetentionXml,
  type LockState,
} from "../object-lock.ts";

async function readBody(ctx: S3RequestContext): Promise<string> {
  try {
    return await readBoundedText(ctx.body, ctx.app.config.maxS3XmlBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new S3Error("EntityTooLarge");
    throw error;
  }
}

/**
 * Locate the version a lock request targets: the current object, or an
 * archived version when `?versionId` names one.
 */
function resolveTarget(
  ctx: S3RequestContext,
  bucketId: string,
  key: string,
): { state: LockState; versionId: string; archived: boolean } {
  const versionId = ctx.url.searchParams.get("versionId");
  const current = ctx.app.repos.objects.findByKey(bucketId, key);

  if (!versionId || (current && current.version_id === versionId)) {
    if (!current) throw new S3Error("NoSuchKey", { Key: key });
    return { state: current, versionId: current.version_id, archived: false };
  }

  const archived = ctx.app.repos.objectVersions.find(bucketId, key, versionId);
  if (!archived) throw new S3Error("NoSuchVersion", { VersionId: versionId });
  return { state: archived, versionId, archived: true };
}

function applyLock(
  ctx: S3RequestContext,
  bucketId: string,
  key: string,
  target: { versionId: string; archived: boolean },
  change: {
    lockMode?: "GOVERNANCE" | "COMPLIANCE" | null;
    retainUntil?: string | null;
    legalHold?: boolean;
  },
): void {
  if (target.archived) {
    ctx.app.repos.objectVersions.setLock({
      bucketId,
      objectKey: key,
      versionId: target.versionId,
      ...change,
    });
    return;
  }
  ctx.app.repos.objects.setLock({ bucketId, objectKey: key, ...change });
}

export async function getObjectRetention(
  ctx: S3RequestContext,
  bucketName: string,
  key: string,
): Promise<Response> {
  const { bucket } = authorizeBucket(ctx, bucketName, "s3:GetObject", key);
  const target = resolveTarget(ctx, bucket.id, key);
  if (!target.state.lock_mode || !target.state.retain_until) {
    throw new S3Error("NoSuchObjectLockConfiguration");
  }
  const body = xmlDocument(
    "Retention",
    tag("Mode", target.state.lock_mode) + tag("RetainUntilDate", target.state.retain_until),
  );
  return xmlResponse(body, 200, { "x-amz-request-id": ctx.requestId });
}

export async function putObjectRetention(
  ctx: S3RequestContext,
  bucketName: string,
  key: string,
): Promise<Response> {
  const userId = requireUser(ctx);
  const { bucket } = authorizeBucket(ctx, bucketName, "s3:PutObject", key);
  if (!bucket.object_lock_enabled) {
    throw new S3Error("InvalidRequest", {
      Reason: "Object Lock is not enabled for this bucket.",
    });
  }
  const target = resolveTarget(ctx, bucket.id, key);
  const requested = parseRetentionXml(await readBody(ctx));

  // Retention may be extended but not shortened, or the lock would be
  // advisory rather than binding.
  const permitted = canReplaceRetention({
    current: target.state,
    nextRetainUntil: requested.retainUntil,
    nextMode: requested.mode,
    bypassGovernance: bypassRequested(ctx.headers),
    isBucketOwner: userId === bucket.user_id,
  });
  if (!permitted) {
    throw new S3Error("AccessDenied", {
      Reason: "The retention period cannot be shortened or downgraded.",
    });
  }

  applyLock(ctx, bucket.id, key, target, {
    lockMode: requested.mode,
    retainUntil: requested.retainUntil,
  });
  ctx.app.repos.audit.record({
    userId,
    credentialId: ctx.credentialId,
    action: "s3.PutObjectRetention",
    bucketName,
    bucketId: bucket.id,
    objectKey: key,
    statusCode: 200,
    requestId: ctx.requestId,
    detail: { mode: requested.mode, retainUntil: requested.retainUntil },
  });
  return new Response(null, { status: 200, headers: { "x-amz-request-id": ctx.requestId } });
}

export async function getObjectLegalHold(
  ctx: S3RequestContext,
  bucketName: string,
  key: string,
): Promise<Response> {
  const { bucket } = authorizeBucket(ctx, bucketName, "s3:GetObject", key);
  const target = resolveTarget(ctx, bucket.id, key);
  const body = xmlDocument(
    "LegalHold",
    tag("Status", target.state.legal_hold === 1 ? "ON" : "OFF"),
  );
  return xmlResponse(body, 200, { "x-amz-request-id": ctx.requestId });
}

export async function putObjectLegalHold(
  ctx: S3RequestContext,
  bucketName: string,
  key: string,
): Promise<Response> {
  const userId = requireUser(ctx);
  const { bucket } = authorizeBucket(ctx, bucketName, "s3:PutObject", key);
  if (!bucket.object_lock_enabled) {
    throw new S3Error("InvalidRequest", {
      Reason: "Object Lock is not enabled for this bucket.",
    });
  }
  const target = resolveTarget(ctx, bucket.id, key);
  // A legal hold is deliberately symmetrical: whoever can place one can lift
  // it. Its purpose is an indefinite pause, not an irreversible lock — that
  // is what COMPLIANCE retention is for.
  const hold = parseLegalHoldXml(await readBody(ctx));

  applyLock(ctx, bucket.id, key, target, { legalHold: hold });
  ctx.app.repos.audit.record({
    userId,
    credentialId: ctx.credentialId,
    action: "s3.PutObjectLegalHold",
    bucketName,
    bucketId: bucket.id,
    objectKey: key,
    statusCode: 200,
    requestId: ctx.requestId,
    detail: { legalHold: hold },
  });
  return new Response(null, { status: 200, headers: { "x-amz-request-id": ctx.requestId } });
}

export async function getObjectLockConfiguration(
  ctx: S3RequestContext,
  bucketName: string,
): Promise<Response> {
  const { bucket } = authorizeBucket(ctx, bucketName, "s3:ListBucket");
  if (!bucket.object_lock_enabled) {
    throw new S3Error("ObjectLockConfigurationNotFoundError", { BucketName: bucketName });
  }

  let rule = "";
  const parsed = parseDefault(bucket.object_lock_default_json);
  if (parsed) {
    rule =
      `<Rule><DefaultRetention>` +
      tag("Mode", parsed.mode) +
      (parsed.days !== undefined ? tag("Days", parsed.days) : "") +
      (parsed.years !== undefined ? tag("Years", parsed.years) : "") +
      `</DefaultRetention></Rule>`;
  }

  return xmlResponse(
    xmlDocument(
      "ObjectLockConfiguration",
      tag("ObjectLockEnabled", "Enabled") + rule,
    ),
    200,
    { "x-amz-request-id": ctx.requestId },
  );
}

export async function putObjectLockConfiguration(
  ctx: S3RequestContext,
  bucketName: string,
): Promise<Response> {
  const userId = requireUser(ctx);
  const { bucket } = authorizeBucket(ctx, bucketName, "s3:PutBucketAcl");
  const body = await readBody(ctx);

  const enabled = /<ObjectLockEnabled>\s*([^<]*?)\s*<\/ObjectLockEnabled>/.exec(body)?.[1];
  if (enabled !== "Enabled") {
    throw new S3Error("MalformedXML", { Reason: "ObjectLockEnabled must be Enabled." });
  }
  if (!bucket.object_lock_enabled) {
    // Object Lock requires versioning, so enabling it turns versioning on too.
    ctx.app.repos.buckets.enableObjectLock(bucket.id);
  }

  const mode = /<Mode>\s*([^<]*?)\s*<\/Mode>/.exec(body)?.[1];
  if (mode) {
    if (!isLockMode(mode)) {
      throw new S3Error("MalformedXML", { Reason: "Mode must be GOVERNANCE or COMPLIANCE." });
    }
    const days = /<Days>\s*(\d+)\s*<\/Days>/.exec(body)?.[1];
    const years = /<Years>\s*(\d+)\s*<\/Years>/.exec(body)?.[1];
    if (!days && !years) {
      throw new S3Error("MalformedXML", { Reason: "DefaultRetention needs Days or Years." });
    }
    ctx.app.repos.buckets.setObjectLockDefault(
      bucket.id,
      JSON.stringify(days ? { mode, days: Number(days) } : { mode, years: Number(years) }),
    );
  }

  ctx.app.repos.audit.record({
    userId,
    credentialId: ctx.credentialId,
    action: "s3.PutObjectLockConfiguration",
    bucketName,
    bucketId: bucket.id,
    statusCode: 200,
    requestId: ctx.requestId,
    detail: { mode: mode ?? null },
  });
  return new Response(null, { status: 200, headers: { "x-amz-request-id": ctx.requestId } });
}

function parseDefault(
  raw: string | null,
): { mode: string; days?: number; years?: number } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { mode?: string; days?: number; years?: number };
    if (!parsed.mode) return null;
    return parsed as { mode: string; days?: number; years?: number };
  } catch {
    return null;
  }
}
